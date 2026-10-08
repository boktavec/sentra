import type { Pool } from "pg";
import type { Logger } from "@sentra/ts-platform";
import * as metrics from "./metrics.ts";
import { createPoller } from "./poller.ts";

/** What nodemailer's transporter offers; tests pass a real transporter pointed at Mailpit. */
export interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface EmailSenderOptions {
  transport: MailTransport;
  from: string;
  logger: Logger;
  maxAttempts: number;
  /** How long a claimed email is hidden from other senders; after a crash it is retried then. */
  leaseSeconds: number;
  backoffBaseSeconds: number;
}

interface Claimed {
  id: string;
  invitation_id: string;
  org_id: string;
  subject: string;
  body: string;
  attempts: number;
  to_email: string;
  deliverable: boolean;
}

const MAX_BACKOFF_SECONDS = 3600;
const MAX_PER_TICK = 100;

/** Only the error code: SMTP error text can contain the recipient's address. */
const describeError = (err: unknown) => {
  const { code, responseCode } = err as { code?: string; responseCode?: number };
  return [code, responseCode].filter(Boolean).join(" ") || "send_failed";
};

/**
 * Claims one due email without holding a lock while it is sent: a single UPDATE moves its
 * `next_attempt_at` forward by the lease, so other senders skip it and a crashed sender's email
 * comes back after the lease. SKIP LOCKED lets several API replicas claim different rows at once.
 */
async function claim(pool: Pool, leaseSeconds: number) {
  const { rows } = await pool.query<Claimed>(
    `UPDATE invitation_emails e
     SET attempts = e.attempts + 1, next_attempt_at = now() + make_interval(secs => $1)
     WHERE e.id = (
       SELECT id FROM invitation_emails
       WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING e.id, e.invitation_id, e.subject, e.body, e.attempts,
       (SELECT email FROM invitations WHERE id = e.invitation_id) AS to_email,
       (SELECT org_id FROM invitations WHERE id = e.invitation_id) AS org_id,
       (SELECT status = 'pending' AND expires_at > now() FROM invitations
        WHERE id = e.invitation_id) AS deliverable`,
    [leaseSeconds],
  );
  return rows[0];
}

async function refreshQueueGauges(pool: Pool) {
  const { rows } = await pool.query<{ depth: number; oldest: number | null }>(
    `SELECT count(*)::int AS depth, extract(epoch FROM now() - min(created_at))::float AS oldest
     FROM invitation_emails WHERE status = 'pending'`,
  );
  metrics.setGauge("email_queue_depth", rows[0]!.depth);
  metrics.setGauge("email_oldest_pending_age_seconds", rows[0]!.oldest ?? 0);
}

export function createEmailSender(pool: Pool, options: EmailSenderOptions) {
  const { logger } = options;
  const finish = (id: string, status: "sent" | "cancelled" | "failed", error?: string) =>
    pool.query(
      `UPDATE invitation_emails
       SET status = $2, body = NULL, last_error = $3,
           sent_at = CASE WHEN $2 = 'sent' THEN now() END
       WHERE id = $1`,
      [id, status, error ?? null],
    );

  /** Sending was refused or failed: retry later with exponential backoff, or give up. */
  async function failed(mail: Claimed, err: unknown) {
    const reason = describeError(err);
    const ids = { emailId: mail.id, invitationId: mail.invitation_id, orgId: mail.org_id };
    if (mail.attempts >= options.maxAttempts) {
      await finish(mail.id, "failed", reason);
      metrics.inc("email_failed_total", { reason });
      logger.error({ ...ids, reason, attempts: mail.attempts }, "email_failed");
      return;
    }
    const delay = Math.min(
      options.backoffBaseSeconds * 2 ** (mail.attempts - 1),
      MAX_BACKOFF_SECONDS,
    );
    await pool.query(
      `UPDATE invitation_emails SET last_error = $2, next_attempt_at = now() + make_interval(secs => $3)
       WHERE id = $1`,
      [mail.id, reason, delay],
    );
    metrics.inc("email_retries_total", { reason });
    logger.warn({ ...ids, reason, attempts: mail.attempts, retryInSeconds: delay }, "email_retry");
  }

  async function deliver(mail: Claimed) {
    // A revoked, replaced, used, or expired invitation must not be emailed as if it still works.
    if (!mail.deliverable) {
      await finish(mail.id, "cancelled");
      metrics.inc("email_cancelled_total");
      logger.info({ emailId: mail.id, invitationId: mail.invitation_id }, "email_cancelled");
      return;
    }
    try {
      await options.transport.sendMail({
        from: options.from,
        to: mail.to_email,
        subject: mail.subject,
        text: mail.body,
      });
    } catch (err) {
      await failed(mail, err);
      return;
    }
    // If this update fails after the send, the lease expires and the email is sent again:
    // delivery is at-least-once, and a duplicate invitation email is harmless.
    await finish(mail.id, "sent");
    metrics.inc("email_sent_total");
    logger.info(
      { emailId: mail.id, invitationId: mail.invitation_id, orgId: mail.org_id },
      "email_sent",
    );
  }

  /** Delivers every due email (up to a cap) and returns how many it handled. */
  async function tick(): Promise<number> {
    let handled = 0;
    try {
      while (handled < MAX_PER_TICK) {
        const mail = await claim(pool, options.leaseSeconds);
        if (!mail) break;
        await deliver(mail);
        handled++;
      }
      await refreshQueueGauges(pool);
    } catch (err) {
      // The database was unreachable; the next tick tries again.
      metrics.inc("email_sender_errors_total");
      logger.error({ err: String(err) }, "email_sender_error");
    }
    return handled;
  }

  return { tick, ...createPoller(tick) };
}
