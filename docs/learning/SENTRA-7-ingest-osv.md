# SENTRA-7: Ingest OSV vulnerability data

## What was built

- **A crawler worker** (`services/crawler`, Python) that consumes signed `crawl.requested` events, downloads OSV's bulk `all.zip` for npm or PyPI, stores it untouched in S3-compatible storage, and publishes `artifact.ingested`.
- **A run table** (`ingestion_runs`, migration `006`) recording each run's state: `fetching -> stored -> published`, or `unchanged` / `failed`.
- **Versioned event contracts** (JSON Schema in `packages/contracts/events/`) and an ADR for the conventions.
- **Local infrastructure**: Redpanda and SeaweedFS in compose.
- **Fault-injection tests** against a real local HTTP server, real Postgres, real S3 API and real Redpanda.

## Why it is designed this way

- **Fetch is separate from normalize.** The crawler stores the zip and hands over a reference. It never parses OSV records, so the pipeline (SENTRA-11) can be fixed and re-run against the same bytes without touching the network. This is "preserve raw data so processing can be replayed" in practice.
- **Content-addressed storage.** The key is the SHA-256 of the bytes, so identical content is stored once and an existing object is never overwritten. Duplicates are impossible by construction, not by checking.
- **Idempotency comes from the requester's `runId`.** The broker may deliver a request twice. `INSERT ... ON CONFLICT DO NOTHING` on `runId` makes the second delivery land on the same row and do nothing.
- **A resumable state machine instead of a transaction.** Storing a file and publishing an event can't be one atomic step. So the run records how far it got, and a retry picks up from there. A crash after storing but before publishing is recovered by redelivery, and the republished event has the same `eventId`, so consumers can dedupe.
- **Commit the offset only after the work is recorded.** Handled outcomes (including a bad request or a permanent failure) are committed so one poison message can't block the partition. An infrastructure error leaves the offset uncommitted and the consumer seeks back to it.
- **No URLs in events, and signed requests.** An event that named a URL would let anyone who can publish make the crawler fetch anything (SSRF). The crawler maps source and ecosystem to its own configured, HTTPS-only base URL, and verifies an HMAC over the request.

## Alternatives considered

- **OSV REST API per package** instead of bulk dumps: smaller, but it couples ingestion to SBOMs that don't exist yet and is rate-sensitive.
- **Postgres polling or a transactional outbox** instead of an event stream: simpler or safer, but diverges from the documented architecture or adds a relay to run.
- **One event per advisory:** fine-grained replay, but tens of thousands of messages per run and a crawler that must know OSV's zip layout.
- **Crawler-generated run IDs or deterministic hashes:** the ID wouldn't exist until work started, or deliberate re-runs would need an escape hatch.
- **Ed25519 signatures, per-publisher keys:** better key separation, but real key-management cost before a threat needs it.
- **MinIO:** the documented choice, but official images are no longer published, so the local store is SeaweedFS. The crawler uses the plain S3 API, so the store is swappable.

## Tradeoffs made

- **Whole-zip artifacts push work downstream.** The pipeline must stream a ~208 MiB zip and checkpoint its progress. In return the crawler stays tiny and replay is one object.
- **Recovery waits for redelivery.** If the crawler crashes between storing and publishing, the event goes out on the next delivery or request, not instantly. A stuck-run sweep is a documented follow-up.
- **A shared HMAC secret** means anything that can verify can also forge. That is acceptable for one team and a handful of services.
- **Keep everything.** Every changed upstream zip stays in the bucket. Retention is deferred until growth is measured.
- **A lease, not fencing.** A worker that outlives its 30 minute lease could race a second worker. State transitions are guarded, but not fenced by owner.

## Scaling implications

- **Measured, not guessed:** npm is 217,953,791 bytes and downloaded in 6.0 s, PyPI is 35,674,361 bytes in 1.4 s, and an unchanged repeat costs one 304 in about 0.1 s. The 15 minute timeout and 1 GiB cap are therefore very generous.
- Data volume is small. Growth will come from more ecosystems and sources, which is configuration plus a source adapter, not new architecture.
- Workers scale horizontally by adding consumers to the group. The lease keeps two workers off the same run, and `max.poll.interval.ms` is raised to an hour so a long download doesn't trigger a rebalance.
- The first thing to measure is the pipeline's unzip-and-normalize time, not the download.

## Important failure and security considerations

- **Bad input is dropped and counted, never fatal:** invalid JSON, schema violations, bad or unknown signatures and unsupported ecosystems create no run and no fetch.
- **Resource limits:** timeouts, a size cap checked by header and by streaming count, and a ZIP magic-byte check. The crawler never unzips, so zip bombs are the pipeline's problem.
- **A partial object never appears at the final key:** upload to a temporary key, verify the size, copy into place, delete the temporary key.
- **Least privilege:** the crawler's database role can only select, insert and update `ingestion_runs`. It is created login-less by the migration because migrations must not hold secrets.
- **Never logged:** signatures and secrets.
- **Not handled yet:** alerting (SENTRA-23), topic ACLs for who may publish requests, retention, and a sweep for runs stuck in `stored`.

## Key concepts to understand

- **At-least-once delivery and idempotency:** duplicates are normal, so every step must be safe to repeat.
- **Content addressing:** naming data by its hash gives deduplication and immutability for free.
- **Offsets and commits:** a consumer's position is only durable once committed. Committing before the work risks loss, committing after risks repeats, so we choose repeats and make them harmless.
- **Poison messages:** a message that can never succeed must be acknowledged and recorded, or it blocks everything behind it.
- **Leases versus locks:** a lease expires on its own, so a dead worker can't hold a run forever.
- **The dual-write problem:** writing to storage and a broker can't be atomic, so we make the sequence recoverable instead.
- **Conditional requests (ETag / 304):** ask "has this changed?" before paying to download.
