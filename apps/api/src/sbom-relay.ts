import { Admin } from "@platformatic/kafka";
import type { Pool } from "pg";
import type { Logger } from "@sentra/ts-platform";
import * as metrics from "./metrics.ts";
import { createPoller } from "./poller.ts";

/**
 * Local development only: creates the topic, because the Kafka client does not auto-create it and
 * a single replica is all one local broker can hold. Deployed environments provision topics.
 */
export async function ensureDevTopic(brokers: string[], topic: string): Promise<void> {
  const admin = new Admin({ clientId: "sentra-api-bootstrap", bootstrapBrokers: brokers });
  try {
    if (!(await admin.listTopics()).includes(topic)) {
      await admin.createTopics({ topics: [topic], partitions: 1, replicas: 1 });
    }
  } finally {
    await admin.close();
  }
}

/** What the relay needs from a Kafka producer; tests pass the real one pointed at Redpanda. */
export interface EventPublisher {
  publish(topic: string, key: string, value: string): Promise<void>;
}

export interface SbomRelayOptions {
  publisher: EventPublisher;
  logger: Logger;
  topic: string;
  /** How long a claimed event is hidden from other relays; after a crash it is retried then. */
  leaseSeconds: number;
  backoffBaseSeconds: number;
}

interface Claimed {
  event_id: string;
  import_id: string;
  payload: unknown;
  attempts: number;
}

const MAX_BACKOFF_SECONDS = 300;
const MAX_PER_TICK = 100;

/** Same lease claim as the invitation email sender: one UPDATE, SKIP LOCKED, no lock held while publishing. */
async function claim(pool: Pool, leaseSeconds: number) {
  const { rows } = await pool.query<Claimed>(
    `UPDATE sbom_outbox o
     SET attempts = o.attempts + 1, next_attempt_at = now() + make_interval(secs => $1)
     WHERE o.event_id = (
       SELECT event_id FROM sbom_outbox
       WHERE sent_at IS NULL AND next_attempt_at <= now()
       ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING o.event_id, o.import_id, o.payload, o.attempts`,
    [leaseSeconds],
  );
  return rows[0];
}

async function refreshGauges(pool: Pool) {
  const { rows } = await pool.query<{
    depth: number;
    oldest: number | null;
    uploaded: number | null;
  }>(
    `SELECT (SELECT count(*)::int FROM sbom_outbox WHERE sent_at IS NULL) AS depth,
            (SELECT extract(epoch FROM now() - min(created_at))::float FROM sbom_outbox WHERE sent_at IS NULL) AS oldest,
            (SELECT extract(epoch FROM now() - min(updated_at))::float FROM sbom_imports WHERE status = 'uploaded') AS uploaded`,
  );
  metrics.setGauge("sbom_outbox_pending", rows[0]!.depth);
  metrics.setGauge("sbom_outbox_oldest_age_seconds", rows[0]!.oldest ?? 0);
  // Grows when the broker or the pipeline is down; the signal that uploads are not being processed.
  metrics.setGauge("sbom_uploaded_oldest_age_seconds", rows[0]!.uploaded ?? 0);
}

/**
 * Publishes `sbom.uploaded` events written by `complete`. At-least-once: if marking an event sent
 * fails after publishing, it is published again and consumers dedupe by `eventId`.
 */
export function createSbomRelay(pool: Pool, options: SbomRelayOptions) {
  const { logger, publisher, topic } = options;

  async function publish(event: Claimed) {
    const ids = { eventId: event.event_id, importId: event.import_id };
    try {
      await publisher.publish(topic, event.import_id, JSON.stringify(event.payload));
    } catch (err) {
      const delay = Math.min(
        options.backoffBaseSeconds * 2 ** Math.min(event.attempts - 1, 10),
        MAX_BACKOFF_SECONDS,
      );
      await pool.query(
        "UPDATE sbom_outbox SET next_attempt_at = now() + make_interval(secs => $2) WHERE event_id = $1",
        [event.event_id, delay],
      );
      metrics.inc("sbom_event_publish_failures_total");
      logger.warn(
        { ...ids, attempts: event.attempts, err: String(err) },
        "sbom_event_publish_failed",
      );
      return false;
    }
    await pool.query("UPDATE sbom_outbox SET sent_at = now() WHERE event_id = $1", [
      event.event_id,
    ]);
    metrics.inc("sbom_event_published_total");
    logger.info(ids, "sbom_event_published");
    return true;
  }

  /** Publishes every due event (up to a cap) and returns how many went out. Stops at the first failure. */
  async function tick(): Promise<number> {
    let sent = 0;
    try {
      while (sent < MAX_PER_TICK) {
        const event = await claim(pool, options.leaseSeconds);
        if (!event || !(await publish(event))) break;
        sent++;
      }
      await refreshGauges(pool);
    } catch (err) {
      metrics.inc("sbom_relay_errors_total");
      logger.error({ err: String(err) }, "sbom_relay_error");
    }
    return sent;
  }

  return { tick, ...createPoller(tick) };
}
