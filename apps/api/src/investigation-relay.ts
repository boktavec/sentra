import type { Pool } from "pg";
import type { Logger } from "@sentra/ts-platform";
import * as metrics from "./metrics.ts";
import { createPoller } from "./poller.ts";
import type { EventPublisher } from "./sbom-relay.ts";

interface Row {
  event_id: string;
  investigation_id: string;
  payload: unknown;
  attempts: number;
}

/** Durable outbox relay. A crash after publish causes redelivery, which the worker deduplicates by run state. */
export function createInvestigationRelay(
  pool: Pool,
  options: {
    publisher: EventPublisher;
    logger: Logger;
    leaseSeconds: number;
    backoffBaseSeconds: number;
  },
) {
  async function tick() {
    let sent = 0;
    try {
      while (sent < 100) {
        const { rows } = await pool.query<Row>(
          `UPDATE investigation_outbox o
           SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $1)
           WHERE event_id = (SELECT event_id FROM investigation_outbox
             WHERE sent_at IS NULL AND next_attempt_at <= now()
             ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING event_id, investigation_id, payload, attempts`,
          [options.leaseSeconds],
        );
        const row = rows[0];
        if (!row) break;
        try {
          await options.publisher.publish(
            "investigation.requested",
            row.investigation_id,
            JSON.stringify(row.payload),
          );
          await pool.query("UPDATE investigation_outbox SET sent_at = now() WHERE event_id = $1", [
            row.event_id,
          ]);
          metrics.inc("investigation_event_published_total");
          sent++;
        } catch (err) {
          const delay = Math.min(
            options.backoffBaseSeconds * 2 ** Math.min(row.attempts - 1, 10),
            300,
          );
          await pool.query(
            "UPDATE investigation_outbox SET next_attempt_at = now() + make_interval(secs => $2) WHERE event_id = $1",
            [row.event_id, delay],
          );
          metrics.inc("investigation_event_publish_failures_total");
          options.logger.warn(
            { eventId: row.event_id, error: String(err) },
            "investigation_publish_failed",
          );
          break;
        }
      }
      const { rows } = await pool.query<{ depth: number; oldest: number | null }>(
        `SELECT count(*)::int AS depth,
                extract(epoch FROM now() - min(created_at))::float AS oldest
         FROM investigation_outbox WHERE sent_at IS NULL`,
      );
      metrics.setGauge("investigation_outbox_pending", rows[0]!.depth);
      metrics.setGauge("investigation_outbox_oldest_age_seconds", rows[0]!.oldest ?? 0);
    } catch (err) {
      metrics.inc("investigation_relay_errors_total");
      options.logger.error({ error: String(err) }, "investigation_relay_failed");
    }
    return sent;
  }
  return { tick, ...createPoller(tick) };
}
