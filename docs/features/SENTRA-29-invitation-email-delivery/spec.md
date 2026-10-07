# SENTRA-29: Invitation email delivery

- Status: Implemented, in review
- YouTrack: http://localhost:8080/issue/SENTRA-29 (Identity & Tenant Foundation, size S)
- Owner: Brian Oktavec

## Problem and outcome

- **Who/why:** SENTRA-28 lets admins invite people, but the admin has to copy the link to the invitee by hand. Invitees should receive the link by email, and an outage or slow mail server must not lose invitations or slow down the API.
- **Done means:** Creating an invitation also queues an email in the same transaction. A background sender delivers it over SMTP, retries with backoff when delivery fails, never sends a dead invitation, and clears the stored link once the email is sent or has finally failed. Locally, mail lands in Mailpit.

## Scope

- In scope:
  - Migration `005`: the `invitation_emails` outbox.
  - Queueing in the invitation-create transaction.
  - An in-process sender: claims due emails safely across API replicas, sends over SMTP with `nodemailer`, retries with exponential backoff, gives up after a maximum number of attempts.
  - Config for SMTP, sender address, retry count, poll interval, and the public web URL.
  - Mailpit's SMTP port published in the local stack (and its reverse-DNS lookup turned off), `SMTP_URL` written by `task stack:bootstrap`.
  - Logs, metrics (including queue depth and oldest pending age), tests, learning note.
- Out of scope (future work):
  - HTML email, localization, resend and "delivery status" in the UI, bounce and complaint handling, a dedicated worker service, a real email provider (any SMTP server works by setting `SMTP_URL`).
  - Other kinds of email (the table is specific to invitations).
- Dependencies and related stories:
  - Depends on SENTRA-28 (invitations). SENTRA-23 later owns real metrics and alerts; the counters and gauges here use the existing in-process metrics module.

## Decisions and alternatives

Third-party behavior: `nodemailer` reports a refused connection as `ESOCKET` and a missing greeting as `ETIMEDOUT` (**Verified** in the integration tests against a closed port and a stalled server). Mailpit takes 8 to 16 seconds to greet each new SMTP connection from Docker's port proxy unless reverse DNS is disabled (**Verified** by timing the greeting before and after `MP_SMTP_DISABLE_RDNS`).

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Reliability | Transactional outbox: the email row commits with the invitation | Send inside the request; publish to a queue | No lost email if the provider is down, and the API request never waits on SMTP. Cost: delivery is eventual (a few seconds), and a table to maintain. |
| Where sending runs | In the API process, on a timer | Separate worker service; a real queue | No new infrastructure (AGENTS.md). Cost: sending shares the API's process and connection pool; move it out if load grows. |
| Claiming work | One `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)` that pushes `next_attempt_at` forward by a lease and bumps `attempts` | Hold a transaction (row lock) during the SMTP call | Replicas claim different rows without blocking, and no database lock is held during a slow network call. Cost: a crashed sender's email is retried only after the lease (60 seconds), and may be sent twice. |
| Delivery guarantee | At-least-once | Exactly-once | Exactly-once is not possible with SMTP. A duplicate invitation email is harmless because the token is single-use. |
| Retry policy | Backoff of 30 seconds doubling, capped at one hour; at most `EMAIL_MAX_ATTEMPTS` (default 5, an assumption); then `failed` | Fixed interval; unlimited retries | Gives a short outage time to clear without hammering the server. Cost: after the last attempt an admin must re-invite. |
| Dead invitations | At send time, skip (mark `cancelled`) if the invitation is revoked, replaced, used, or expired | Send anyway; cancel at revoke time | Revoke and replace stay unaware of email, and nobody gets a dead link. |
| The link at rest | The email body (with the token) is stored only while `pending`; set to NULL on `sent`, `cancelled`, and `failed`. A CHECK forces pending rows to have a body | Keep the body for debugging; derive the token on demand | The database never keeps a working link longer than needed. Cost: no replay of a failed email, by design. |
| Error recording | Only the nodemailer error code (for example `ESOCKET`, `ETIMEDOUT`, `EENVELOPE 550`) | Full SMTP error text | SMTP error text can include the recipient's address; logs and tables stay free of it. |
| Email content | Plain text: org name, role, accept link, address to sign in with, expiry date. No inviter name or email | HTML; include the inviter | The recipient needs only the link; the inviter often has no stored name, and showing their email would be extra disclosure. |
| Sender disabled | If `SMTP_URL` is unset the sender does not start, a warning is logged, and emails wait in the outbox | Fail to start | The API stays usable (the admin still gets the link); emails go out once SMTP is configured. |

## Architecture and contracts

- **Affected components and ownership:** `apps/api` owns the outbox and the sender. `apps/web` only changes copy. Local infra: Mailpit's SMTP port and bootstrap output. No new service.
- **Flow (queue):** inside the SENTRA-28 create transaction, after the audit event, render the email (org name read under the org lock) and insert an `invitation_emails` row with the subject and body. A rollback removes the invitation and its email together.
- **Flow (send):** a timer calls `tick()` every `EMAIL_POLL_SECONDS` (default 5). `tick()` claims one due row at a time (up to 100 per tick) and for each: if the invitation is no longer pending and unexpired, mark `cancelled`; otherwise send; on success mark `sent`; on failure either schedule a retry or mark `failed`. A tick that is still running makes the next timer beat skip, and `stop()` waits for the running tick. At the end of every tick the queue-depth and oldest-pending-age gauges are refreshed.
- **Storage contract (migration `005_invitation_emails.sql`):** `invitation_emails(id, invitation_id fk, subject, body null, status pending|sent|failed|cancelled, attempts, next_attempt_at, last_error, created_at, sent_at)`; CHECK that pending rows have a body; partial index on `next_attempt_at` where pending.
- **Configuration:** `SMTP_URL`, `EMAIL_FROM` (default `Sentra <no-reply@sentra.local>`), `EMAIL_MAX_ATTEMPTS` (5), `EMAIL_POLL_SECONDS` (5), `WEB_URL` (default `http://localhost:3000`, used to build the link). No credentials in the repo; `SMTP_URL` may carry credentials in production and is never logged.
- **API contracts:** unchanged. The create response still returns the token as a fallback (see open questions).
- **Compatibility and migration:** additive migration. Invitations created before this migration have no email row and are not emailed.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | **Unknown.** Invitations are rare admin actions, bounded by the SENTRA-28 caps (50 per org per day, assumed) | No target invented | Measure in SENTRA-26/27 |
| Concurrent users or jobs | Several API replicas each ticking every 5 seconds | Design property | Concurrency test below |
| Data size and growth | One row per invitation; rows are kept (without the body) after sending | Bounded by invitation volume | Archive with audit data later |
| Latency or throughput target | **Unknown.** Expect delivery within about one poll interval plus SMTP time when the server is healthy | Assumption | `email_oldest_pending_age_seconds` gauge; baseline in SENTRA-26 |
| Availability and recovery target | An SMTP outage must lose nothing: emails wait and retry for roughly 15 minutes of backoff (30, 60, 120, 240 seconds between 5 attempts), then fail | Design property; the attempt count is an assumption | Outage and retry tests below |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Invitation transaction fails | No invitation and no email row | Integration test with a forced audit failure |
| SMTP server down | Email stays `pending` with its link, `attempts` and `next_attempt_at` advance with backoff, `last_error` holds the code | Integration test against a closed port |
| SMTP comes back | The retry delivers; row ends `sent` with the link cleared | Integration test |
| Never recovers | After the maximum attempts the row is `failed` and the link is cleared; later ticks ignore it | Integration test |
| Backoff growth | 30, 60, 120, ... capped at 3600 seconds | Integration test |
| Several senders or replicas at once | Each email is sent exactly once; every row handled by exactly one sender | Concurrency test with 12 emails and 3 senders |
| Sender stalls or crashes after claiming | Others skip the email while leased; after the lease it is retried; the stalled sender finishing later causes a duplicate send and the row still ends `sent` | Integration test (gated transport) |
| Invitation revoked, replaced, used, or expired before sending | Email `cancelled`, link cleared, nothing sent | Integration tests |
| Database unavailable during a tick | The error is logged and counted; the next tick tries again | Reasoned (no test) |
| `SMTP_URL` unset | Warning at start; emails wait | Reasoned (no test) |
| Token or address in logs | Never; only email and invitation IDs and error codes are logged | Integration test scans captured logs |

## Security, observability, and rollout

- **Authorization, tenant isolation, sensitive data, and abuse limits:**
  - The sender is internal, with no HTTP surface. It reads the recipient from the invitation, never from client input.
  - The link (a secret) exists in `invitation_emails.body` only while the email is pending. Tokens and addresses are never logged; SMTP errors are reduced to codes.
  - The SENTRA-28 caps bound how much mail an org can trigger.
  - Email header injection: the subject contains the org name, whose validation forbids control characters, and `nodemailer` encodes headers.
- **Logs, metrics, traces, and alerts:**
  - Logs (with `emailId`, `invitationId`, `orgId`): `email_sent`, `email_cancelled` (info); `email_retry` (warn); `email_failed`, `email_sender_error` (error); `email_disabled_no_smtp_url` (warn at start).
  - Metrics: `email_sent_total`, `email_retries_total{reason}`, `email_failed_total{reason}`, `email_cancelled_total`, `email_sender_errors_total`; gauges `email_queue_depth` and `email_oldest_pending_age_seconds`.
  - No alerts in this story. SENTRA-23 should alert on a growing oldest-pending age and on any `email_failed_total`.
- **Rollout, migration, rollback, operational owner:** migration `005` runs on API startup. Rollback: drop `invitation_emails` (pending emails would be lost; admins can re-invite). Local: `docker compose up -d mailpit` picks up the published SMTP port and `MP_SMTP_DISABLE_RDNS`, and `task stack:bootstrap` rewrites `.env.sentra` with `SMTP_URL`. Production needs `SMTP_URL`, `EMAIL_FROM`, and `WEB_URL`. Owner: Brian Oktavec.

## Acceptance criteria

- [x] Creating an invitation writes an outbox row in the same transaction; no email is lost if the mail server is down.
- [x] A background sender in the API process claims due emails safely across replicas (`FOR UPDATE SKIP LOCKED`) and sends them over SMTP.
- [x] Failed sends retry with backoff up to a limit, then are marked failed and visible in logs and metrics.
- [x] Delivery is at-least-once; a duplicate send is harmless and a crashed or stalled sender does not lose the email.
- [x] SMTP settings come from environment variables; no credentials in the repo, logs, or issues.
- [x] Mailpit is part of the local stack with SMTP published, and tests read the delivered email from it.
- [x] The email contains the accept link and no more tenant information than the org name and role.
- [x] Metrics and logs cover sent, failed, retry, queue depth, and oldest pending age.

## Verification

- **Manual checks and expected results:**
  - `docker compose up -d mailpit` (or `task stack:up`), `task stack:bootstrap`, `task api:dev`, `task web:dev`.
  - As an admin, invite an address from the members page. Within about five seconds the email appears in Mailpit at http://localhost:8025 with a working link.
  - Stop Mailpit (`docker stop sentra-mailpit-1`), invite another address, and check `SELECT status, attempts, last_error FROM invitation_emails` shows `pending` with a growing `attempts`. Start Mailpit and make the row due (`UPDATE invitation_emails SET next_attempt_at = now()`): it is delivered.
  - Revoke an invitation before it is sent: its email row becomes `cancelled`.
- **Automated tests and what they prove:**
  - API integration (real Postgres, real nodemailer, real Mailpit): every row of the edge-case table above.
  - Playwright (real Zitadel and Mailpit): the invitee's link is taken from the delivered email and equals the link shown to the admin; the whole invite, sign-in, accept flow still passes.
- **Load or failure tests, if relevant:** concurrency (3 senders, 12 emails), stalled sender, and SMTP outage tests.

## Open questions and assumptions to validate

- **Retry count and backoff (assumed):** 5 attempts starting at 30 seconds. Tune from `email_retries_total` and `email_failed_total`.
- **Token in the create response:** still returned so an admin can share the link if delivery is delayed. Revisit once delivery status is visible in the UI.
- **Real provider:** not chosen. Any SMTP server works by configuration; DKIM, SPF, and sender reputation are a deployment concern.
- **Duplicate sends:** accepted as harmless. If an email type is ever added where duplicates matter, it needs its own idempotency design.
