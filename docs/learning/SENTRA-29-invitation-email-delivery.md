# SENTRA-29: Invitation email delivery

## What was built

- **An outbox table** (`invitation_emails`, migration `005`): each invitation writes one row, in the same transaction.
- **A background sender** in the API process that delivers those rows over SMTP with `nodemailer`.
- **Retry and give-up rules**, queue gauges, and logs.
- **Local stack changes**: Mailpit's SMTP port is published and `task stack:bootstrap` writes `SMTP_URL`.

## Why it is designed this way

- **Write the email with the data, send it later.** Sending SMTP inside the request would make every invitation as slow and as fragile as the mail server, and a crash between "saved" and "sent" would silently lose an email. With an outbox, "invitation exists" and "email is owed" are one atomic fact.
- **Claim with a lease, not a long lock.** One `UPDATE` marks a row as taken by pushing `next_attempt_at` into the future, using `FOR UPDATE SKIP LOCKED` to find it. Other API replicas skip it, no database lock is held while we wait on the network, and if the process dies the row simply becomes due again.
- **At-least-once, not exactly-once.** SMTP gives no way to know whether a send that timed out actually went through. We would rather send twice than never, and a duplicate invitation email costs nothing because the token is single-use.
- **Check validity at send time.** An email can wait minutes or hours. By the time it is sent the invitation may be revoked, replaced, used, or expired, so the sender checks and cancels instead of mailing a dead link. Revoke and replace stay unaware of email.
- **Do not keep the secret longer than needed.** The email body contains the accept link. It lives in the table only while the email is pending; after sending, cancelling, or giving up it is erased, and a CHECK constraint guarantees a pending row always has its body.
- **Record error codes, not messages.** SMTP error text often repeats the recipient's address. Storing only the code keeps addresses out of the table and the logs.

## Alternatives considered

- Send inside the request: simple, but couples API latency and success to the mail server.
- A real queue and worker service: the right shape at scale, but new infrastructure with no measured need yet.
- Holding a transaction (row lock) across the SMTP call: simpler claim logic, but a slow server pins a connection and a lock.
- A third-party email API (Resend, SES): better delivery data, but a vendor, an account, and keys in every environment. SMTP works with all of them by configuration.
- Cancelling emails when an invitation is revoked: couples revoke to email. Checking at send time is less code and also covers expiry.

## Tradeoffs made

- Delivery is eventual: up to one poll interval (5 seconds) plus SMTP time in the healthy case.
- Sending shares the API process. A very large backlog would compete with requests, so a tick is capped at 100 emails.
- After the last attempt the email is gone and the admin has to invite again; there is no resend or delivery status in the UI yet.
- Retry numbers (5 attempts from 30 seconds) are assumptions.
- The create response still includes the token, so an admin can share the link when mail is delayed.

## Scaling implications

- Replicas each poll the same table. `SKIP LOCKED` spreads rows across them without blocking, and the partial index on `next_attempt_at` keeps the claim query cheap however many sent rows accumulate.
- The poll is a steady trickle of one indexed query per replica every few seconds, even when idle. Longer intervals or `LISTEN/NOTIFY` are options if that ever matters.
- Sent and failed rows stay forever (without bodies). Archive them with the audit data when volume warrants.

## Important failure and security considerations

- **Crash safety.** A sender that dies after claiming leaves the row leased; it becomes due again after 60 seconds. A sender that stalls and finishes late can cause a duplicate, and the test for that checks the row still ends up `sent`.
- **Outages.** While SMTP is down emails wait and retry with doubling delays up to an hour; nothing is lost until the attempt limit.
- **Secrets.** Neither tokens nor addresses appear in logs or `last_error`, and a test scans captured logs for both.
- **Misconfiguration.** With `SMTP_URL` unset the API still works, logs a warning, and holds emails until sending is configured.
- **A discovered pitfall.** Mailpit stalled every SMTP connection for 8 to 16 seconds on a reverse-DNS lookup behind Docker's port proxy. It looked like flaky tests until the greeting was timed directly.

## Key concepts to understand

- The transactional outbox pattern and why it solves the dual-write problem.
- Leases (time-limited claims) versus locks, and why leases survive crashes.
- `FOR UPDATE SKIP LOCKED` for work queues in Postgres.
- At-least-once delivery and why handlers must tolerate duplicates.
- Exponential backoff with a cap.
- Checking validity at the point of use instead of trying to cancel work in flight.
