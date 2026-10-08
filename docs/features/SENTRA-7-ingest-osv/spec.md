# SENTRA-7: Ingest OSV vulnerability data

- Status: Approved
- YouTrack: SENTRA-7 (project SENTRA, "[MVP] Ingest OSV Vulnerability Data")
- Owner: Sentra operator / project owner

## Problem and outcome

- A Sentra operator needs authoritative vulnerability data in the platform so tenant dependencies can later be matched against known vulnerabilities (SENTRA-13). Today there is no ingestion path at all.
- Done means: publishing a signed `crawl.requested` event for `source=osv` and an ecosystem (npm or PyPI) causes the crawler to download that ecosystem's OSV bulk dump, store it untouched in object storage, record the run in Postgres, and publish `artifact.ingested`. Failures are visible in logs, metrics, run state and a `crawl.failed` event. Re-delivering the same request, or re-fetching unchanged data, creates no duplicate artifact and no second run.

## Scope

- In scope:
  - New Python crawler worker (`services/crawler`) consuming `crawl.requested`.
  - OSV bulk-dump adapter for **npm** and **PyPI** (`all.zip`).
  - Raw artifact storage in SeaweedFS (S3 API), content-addressed.
  - `ingestion_runs` table (API migration) and a least-privilege crawler role.
  - Event contracts (JSON Schema) for `crawl.requested`, `artifact.ingested`, `crawl.failed`.
  - HMAC signing and verification of `crawl.requested`.
  - SeaweedFS (S3 API) and Redpanda added to the local compose stack.
  - Timeouts, bounded retries with backoff, size cap, conditional GET, metrics and structured logs.
- Out of scope (documented, not built):
  - Unzipping, parsing, normalizing or deduplicating OSV records (SENTRA-11, SENTRA-12).
  - Scheduling and run-tracking UI/API (SENTRA-10).
  - Other sources (SENTRA-8 CISA KEV, SENTRA-9 GHSA) and other OSV ecosystems.
  - Tenant audit events (SENTRA-20), CI wiring (SENTRA-25), full local-stack tooling (SENTRA-24).
  - Raw artifact retention/lifecycle policy (follow-up once growth is measured).
  - Per-publisher keys or asymmetric signatures.
- Dependencies and related stories:
  - Depends on: none.
  - Unblocks: SENTRA-10, SENTRA-11. Sets the pattern for SENTRA-8 and SENTRA-9.

## Decisions and alternatives

Claims about OSV were checked against the live bucket on 2026-10-07 and are marked **Verified**.

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Fetch mode | Bulk `all.zip` per ecosystem | REST API per package; all ecosystems | Simplest and replayable; no API rate limit. Downloads more than any one tenant needs. API mode would couple ingestion to SBOMs that do not exist yet. |
| Ecosystems | npm, PyPI | npm+PyPI+Go+Maven; npm only | Matches the project's own stack and gives two real ecosystems. Adding one later is config. |
| Handoff | SeaweedFS (S3 API) + Redpanda; publish `artifact.ingested` after storing | Postgres polling; transactional outbox | Matches documented architecture and decouples fetch from normalize. Gap between store and publish handled by resumable runs (below). |
| Broker | Redpanda locally, standard Kafka client API | Apache Kafka (KRaft) | Single lightweight binary, Kafka-compatible; moving to Kafka or a managed service is a config change. |
| Crash between store and publish | Resumable idempotent run: `fetching -> stored -> published`; retry or next run re-publishes; consumers dedupe by event ID | Periodic sweep; accept the gap | Uses existing mechanisms. Recovery waits for the next request. Revisit a sweep if this delay proves a problem. |
| Trigger | Long-running worker consuming `crawl.requested`; operator publishes manually for now | One-shot CLI; in-process interval loop | Matches documented event families and is ready for SENTRA-10. Costs a consumer loop and deployment now. |
| Run ID | Requester supplies `runId` (UUID); `INSERT ... ON CONFLICT (run_id) DO NOTHING` | Crawler-generated; deterministic hash | Stable before work starts; redelivery maps to the same row. Requesters must generate IDs. |
| Artifact and event granularity | Whole zip stored; one `artifact.ingested` per ecosystem per run | Per-advisory objects/events; manifest | Crawler never parses OSV schema; tiny, few events. Pipeline must stream a large zip and checkpoint (SENTRA-11). |
| Limits | Assumptions in the targets table | Crawler-side auto-retry of failed runs | Retry is a new request with a new `runId`, keeping SENTRA-10 the single owner of scheduling. |
| Security | No URLs in events; fixed HTTPS allowlist in config; size cap; magic-byte check; HMAC-signed requests | Unsigned events; Ed25519; per-publisher keys | HMAC-SHA256 with `keyId` using stdlib `hmac`, supports overlapping keys for rotation. Verifier can also forge, which is acceptable for one team. |
| Schema ownership | `ingestion_runs` in `apps/api/migrations`; crawler uses a dedicated role | Separate crawler schema and migrations; crawler via API | One migration history and tool. Couples crawler deploys to API migrations. |
| Testing | Integration tests on compose services plus a local fake OSV server; unit tests for signing, backoff, state machine | testcontainers; in-memory fakes | Tests real storage/messaging and failure injection. Requires Docker locally; CI waits on SENTRA-25. |
| Contract form | JSON Schema in `packages/contracts/events/`, versioned | Pydantic only; Avro/Protobuf + registry | Language-neutral and test-enforced without a registry dependency. |
| Raw layout and retention | `raw/osv/<ecosystem>/<sha256>.zip` plus `<sha256>.json` sidecar; keep everything for MVP | Lifecycle expiry; key by run ID | Immutable and deduplicated by construction. Bucket grows with each changed upstream zip; retention is follow-up. |

OSV facts:

- **Verified (2026-10-07):** `https://osv-vulnerabilities.storage.googleapis.com/{npm,PyPI}/all.zip` returns `200`, `content-type: application/zip`, a `content-length` (npm 217,953,791 bytes, about 208 MiB; PyPI 35,674,361 bytes, about 34 MiB), `etag` and `last-modified`. A request with `If-None-Match` set to the npm ETag returned `304`.
- **Assumed:** the bucket layout and ecosystem folder names stay stable; there is no documented rate limit on the bucket. Validate by monitoring non-2xx/304 responses and reviewing OSV docs before release (use context7 or the OSV docs and record the finding in the PR).

## Architecture and contracts

- Affected components and ownership:
  - `services/crawler` (new Python service): worker, OSV adapter, SeaweedFS (S3 API) and Postgres clients, signature verification, metrics.
  - `apps/api/migrations`: `ingestion_runs` table and crawler role grants.
  - `packages/contracts/events/`: JSON Schemas and a short doc.
  - `infra/docker/compose.yml`: SeaweedFS (S3 API) and Redpanda services.
- Flow:

```text
operator/scheduler --signed crawl.requested--> Redpanda --> crawler worker
  verify signature + schema -> upsert run (run_id) -> conditional GET (ETag)
    304 / same hash -> run succeeded(unchanged), no new artifact
    200 -> stream to SeaweedFS (S3 API) as raw/osv/<eco>/<sha256>.zip (+ sidecar), run=stored
  publish artifact.ingested -> run=published
  on exhausted retries -> run=failed, publish crawl.failed
```

- Contracts (all share an envelope: `eventId`, `type`, `version`, `timestamp`, `correlationId`):
  - `crawl.requested` v1: `runId`, `source` (`osv`), `ecosystem` (`npm`|`PyPI`), `keyId`, `signature`. Signature is HMAC-SHA256 over canonical JSON of the event excluding `signature`.
  - `artifact.ingested` v1: `runId`, `source`, `ecosystem`, `artifact` (`bucket`, `key`, `sha256`, `sizeBytes`), `fetchedAt`.
  - `crawl.failed` v1: `runId`, `source`, `ecosystem`, `reason`, `attempts`.
- `ingestion_runs` (migration `006_ingestion_runs.sql`): `run_id` PK, `source`, `ecosystem`, `status` (`fetching`|`stored`|`published`|`unchanged`|`failed`), `artifact_key`, `sha256`, `etag`, `size_bytes`, `attempts`, `error`, `correlation_id`, `claimed_until` (worker lease so two workers never fetch the same run), `created_at`, `updated_at`. No `tenant_id`: global reference data. Event fields are camelCase to match `packages/contracts`; Postgres columns are snake_case.
- Compatibility: new table and new events only; no changes to existing contracts. Event schema changes require a new version.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | Low: a handful of `crawl.requested` per day | **Assumed** (manual or daily scheduled) | Count events in first weeks |
| Concurrent users or jobs | One download per ecosystem at a time | **Assumed** | Concurrency test: duplicate requests produce one run |
| Data size and growth | npm ~208 MiB, PyPI ~34 MiB per changed zip | **Verified** 2026-10-07 | Track `sizeBytes` and bucket size; set retention later |
| Download size cap | 1 GiB per artifact (about 5x current npm) | **Assumed** | Covered by an oversize test. Current npm is about 21% of the cap; revisit when it passes about 50% |
| Timeouts | 10 s connect, 60 s read, 15 min total for the whole fetch (all attempts and the backoff between them; SENTRA-30) | **Assumed** | **Measured 2026-10-08** (local, residential link): npm 217,953,791 B in 6.0 s, PyPI 35,674,361 B in 1.4 s, repeat run 304 in 0.1 s. The 15 min total is about 150x headroom; kept deliberately generous for slower networks and growth, tune once deployed |
| Retries | Max 5 attempts, exponential backoff with full jitter, 1 s base, 60 s cap; retry network errors, 5xx, 429; other 4xx fail immediately | **Assumed** | Fault-injection tests against the fake OSV server |
| Latency or throughput target | **Unknown** (no end-to-end freshness target set) | Not invented | Measure run duration from metrics before setting an SLO (SENTRA-26) |
| Availability and recovery | **Unknown**; recovery is by re-publishing `crawl.requested` or the next scheduled run | Not invented | Crash-injection test between `stored` and `published` |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Duplicate or redelivered `crawl.requested` (same `runId`) | Same run row; no second download or event beyond resuming an unfinished run | Integration test: publish twice, assert one run and one artifact |
| Upstream unchanged (304 or identical SHA-256) | Run ends `unchanged`; no new object, no `artifact.ingested` | Fake OSV server returns 304; assert state and no event |
| Invalid, unsigned, bad-signature, unknown `keyId`, or schema-invalid event | Logged, counted in a metric, dropped; no run created | Unit and integration tests |
| Response is not a ZIP (no `PK` magic) or exceeds size cap | Download aborted; run `failed`; nothing left in the final key | Fake server serves bad body and oversized body |
| 429 / 5xx / timeout | Retried up to 5 times with jittered backoff; then `failed` plus `crawl.failed` | Fault injection |
| Non-429 4xx | Fails immediately, no retries | Fake server returns 404 |
| Crash after `stored`, before `published` | Next delivery or request finds `stored` and publishes; consumers dedupe by `eventId` | Kill-and-restart test |
| Crash mid-download | Partial object is never visible at the final key (write to temp key, then copy/rename after hash check); run resumes from `fetching` | Kill test mid-stream |
| Two workers pick up the same `runId` | Row-level claim via the `claimed_until` lease so only one worker fetches | Concurrency test |
| Poison message | Offset committed after the run is recorded `failed`; partition is not blocked. Unparseable, pathologically nested, unencodable or unsigned payloads are dropped; a request that keeps raising a non-dependency error is abandoned after 3 attempts, and only a validly signed one fails its run and publishes `crawl.failed` (SENTRA-30). Dependency outages are retried for as long as they last | Test with malformed payload; SENTRA-30 tests |
| SeaweedFS (S3 API), Postgres or Redpanda unavailable | Worker does not commit the offset; message is redelivered; health metric reflects the outage | Stop each dependency in integration test |
| Tenant boundary | Not applicable: global public data, no tenant data in runs, artifacts or events | Review; schema has no `tenant_id` |

## Security, observability, and rollout

- Authorization, tenant isolation, sensitive data, abuse limits:
  - Data is public and tenant-free. Events carry no URLs; the crawler fetches only allowlisted HTTPS URLs from its own config.
  - `crawl.requested` is HMAC-signed with `keyId`; multiple keys can be configured for rotation. Secrets come from env/secrets, never the repo.
  - Crawler Postgres role can only read/write `ingestion_runs`. Crawler never unzips artifacts (zip-bomb handling belongs to SENTRA-11).
  - Topic ACLs for who may publish are a deployed-environment concern, documented not enforced here.
- Logs, metrics, traces, alerts:
  - Structured logs with `runId` and `correlationId`, following `packages/contracts/logging.md`.
  - Metrics (`crawler_*`, Prometheus on `127.0.0.1:9102/metrics`): requests by outcome (which covers runs by status and drops by reason), request duration, bytes downloaded, fetch retries, worker errors. Consumer lag is read from the broker (`rpk group describe sentra-crawler`), not exported by the crawler.
  - Alerts: **Unknown** until SENTRA-23 defines the metrics stack; failed runs and stuck `fetching`/`stored` runs are the candidates.
- Rollout, migration, rollback, operational owner:
  - Additive migration and new service; rollback is stopping the worker and, if needed, dropping the table. Raw artifacts are retained.
  - Operator owns manual requests until SENTRA-10.

## Acceptance criteria

- [ ] Publishing a valid signed `crawl.requested` for npm or PyPI downloads that ecosystem's OSV `all.zip` (AC1).
- [ ] The raw zip is stored at `raw/osv/<ecosystem>/<sha256>.zip` with a sidecar, before any publish (AC2).
- [ ] Each request has a stable `runId`; redelivery maps to the same run (AC3).
- [ ] Connect/read/total timeouts and the size cap are enforced, with conditional GET to avoid needless downloads (AC4).
- [ ] Temporary failures retry at most 5 times with jittered backoff, then fail the run (AC5).
- [ ] Re-ingesting unchanged or duplicate data creates no duplicate artifact, run or event (AC6).
- [ ] Failed runs are visible in run state, logs, metrics and a `crawl.failed` event (AC7).
- [ ] `artifact.ingested` is published after storage, and the crawler has no code that parses OSV records (AC8).
- [ ] Unsigned, bad-signature or schema-invalid requests are dropped without creating a run.
- [ ] A crash between `stored` and `published` is recovered by redelivery or the next request.

## Verification

- Manual checks and expected results:
  - `task` brings up Postgres, SeaweedFS (S3 API) and Redpanda; the worker starts. Publish a signed `crawl.requested` with `rpk` for npm: the run reaches `published`, the object exists in SeaweedFS (S3 API) under its SHA-256, and `artifact.ingested` appears on the topic.
  - Publish the same request again: no second run or object. Publish a new `runId` while upstream is unchanged: run ends `unchanged`.
  - Publish an unsigned event: nothing is created and the dropped-event metric increments.
  - Record the measured npm download duration and adjust timeouts if needed.
- Automated tests and what they prove:
  - Unit: signature canonicalization and verification, backoff schedule, run state machine transitions, schema validation.
  - Integration (compose services, fake OSV server serving a truncated real-shaped zip): happy path, duplicate delivery, 304, 429/5xx/timeout/404, non-ZIP, oversized body, crash recovery, concurrent workers, poison message, dependency outage.
  - Contract tests: every emitted event validates against its JSON Schema.
- Load or failure tests, if relevant: the integration fault-injection cases above; no load test until SENTRA-27.

## Open questions and assumptions to validate

- Timeouts, retry bounds and the 1 GiB cap are assumptions; validate with the first real npm and PyPI downloads (owner: implementer, before PR).
- Confirm in OSV documentation that bulk dumps carry no rate limit or usage terms we must honor; record the finding in the PR (owner: implementer, before PR).
- Retention policy for raw artifacts: follow-up once bucket growth is measured (owner: operator, before the bucket exceeds an agreed size).
- Whether a stuck-run sweep is needed: decide if the delay before recovery proves a problem (owner: operator, after SENTRA-10).
- Alert thresholds depend on SENTRA-23 and SLOs on SENTRA-26.
- Redpanda versus Apache Kafka for deployed environments: not decided; local is Redpanda with the standard Kafka API.
- ADR candidate: event envelope and contract conventions, since SENTRA-8, 9, 10 and 11 will depend on them (decide when reviewing this spec).
