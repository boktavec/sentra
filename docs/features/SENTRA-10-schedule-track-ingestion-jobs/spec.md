# SENTRA-10: Schedule and Track Ingestion Jobs

- Status: Approved
- YouTrack: http://localhost:8080/issue/SENTRA-10
- Owner: Sentra platform (crawler)

## Problem and outcome

Ingestion today starts only when someone runs `python -m crawler.request`. Operators need security data to stay current without manual action, and need to see what ran, what failed, and why.

Done means: every configured source is requested on its schedule; every run has a record with source, start, completion, status and failure information; overlap per source is bounded; transient failures retry automatically; operators can list run status from a command and from metrics; scheduling can be switched off.

## Scope

- In scope:
  - A scheduler process in `services/crawler` that publishes signed `crawl.requested` events.
  - Run-record extension (`ingestion_runs`) and a scheduler DB role (migration 017).
  - Per-source cap on active runs, retry with backoff of transient failures, expiry of lost requests.
  - A transient/permanent classification on `crawl.failed`.
  - `task crawler:runs` CLI, Prometheus metrics, structured logs.
  - Scheduler kill switch.
- Out of scope:
  - HTTP/API/UI for run status and an operator authorization model (follow-up story).
  - Runtime-editable schedules (DB-backed schedule table).
  - An adapter registry refactor of `ingest.target()`.
  - Adopting an external orchestrator (Airflow/Temporal); this design only keeps that door open.
- Dependencies and related stories: SENTRA-7 (crawler, `ingestion_runs`), SENTRA-8 (`cisa-kev` source), SENTRA-30 (crawler hardening), ADR 0002 (event conventions).

## Decisions and alternatives

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Scheduler placement | Separate Python process in `services/crawler`; publishes `crawl.requested` via the existing `request.build()` | In the API process (`setInterval`); external cron / k8s CronJob | Reuses signing and publishing code; scales and deploys independently; replaceable because it only emits events. Costs one more process. |
| Multi-replica safety | Postgres lease row per tick/source | Single replica only | Safe to run more than one replica; one small table. |
| Concurrency | Overlap allowed, capped per source+ecosystem (default 2 active runs); a tick above the cap is skipped, logged and counted | Skip while any run is active; queue one pending; unbounded | User chose to allow overlap; the cap keeps it intentional and bounds load if a source hangs. **Assumed:** default of 2 is a guess; validate against observed run duration vs. interval. |
| Schedule config | Versioned `services/crawler/schedules.toml` + `SCHEDULER_ENABLED=false` kill switch | DB table; env vars | Reviewable, no operator write path or auth needed. Cadence changes need a deploy. |
| Default cadence | OSV npm/PyPI hourly, `cisa-kev` every 6h | Daily for all | **Assumed:** feeds change often enough and unchanged runs are cheap (conditional GET). Validate with the `unchanged` rate and feed change frequency. |
| Run record | Scheduler inserts `ingestion_runs` row with `status=requested` and `trigger` before publishing, atomically with the cap check; crawler claim moves it to `fetching` | Separate `scheduled_runs` table | One row per job, one table to inspect. Touches the SENTRA-7 claim path. |
| Retry | Scheduler reads `ingestion_runs.failure_kind` (written with the `crawl.failed` event); transient failures re-requested with a new `runId` at 1/5/15 min, max 3; then wait for the next tick. Permanent failures are not retried | Wait for next tick only; retry everything | Faster recovery without hammering upstreams on permanent errors. Needs a transient/permanent flag. Numbers are **Assumed**; validate against real upstream failure modes. |
| Inspection | `task crawler:runs`, metrics, logs; no API | Operator-only API endpoint | Runs are global and the API has no operator role; designing one is tenant-isolation-sensitive and deserves its own story. |
| Replaceability | Event contract is the seam: any orchestrator that emits a valid signed `crawl.requested` replaces the scheduler; adapters/crawler untouched | Adapter registry | Satisfies the criterion with no refactor. |

Claims about third-party behavior to verify against the running stack before relying on them (all currently **Assumed**): OSV and CISA KEV return ETag/Last-Modified that make unchanged runs cheap (SENTRA-7/8 already rely on this); Redpanda accepts publishes from the scheduler with the same credentials as `crawler.request`.

## Architecture and contracts

- Components:
  - `crawler.scheduler` (new): loads `schedules.toml`, ticks, takes the schedule's row lock in `scheduler_leases`, checks the cap, inserts the `requested` row, publishes `crawl.requested`, and re-requests due transient failures read from `ingestion_runs.failure_kind` (it does not consume `crawl.failed`).
  - Crawler worker (changed): `Runs.claim` must also accept rows in `requested`, set `started_at` on the move to `fetching`, set `completed_at` on terminal states, and record `failure_kind`.
  - `crawler.runs_cli` (new): read-only listing.
- Flow:
  1. Tick: for each enabled source whose interval elapsed and lease is won, count active runs (`requested`, `fetching`, `stored`). If at cap: skip and count. Otherwise insert the `requested` row (`trigger=schedule`) and publish.
  2. Crawler claims by `runId` (existing idempotent path), runs, finishes.
  3. A failed run with `failure_kind` `transient` (or `expired`) is re-requested by the scheduler (`trigger=retry`) with a new `runId`. Implementation note: the scheduler reads this from `ingestion_runs`, which the crawler writes in the same step as the `crawl.failed` event, rather than consuming the event. It survives a scheduler outage, needs no consumer group, and makes the v1/v2 mix irrelevant to retries; the event still carries `failureKind` for other consumers. Only `schedule` and `retry` runs are retried, not manual ones; failures older than 1 hour are not retried (no burst after an outage).
  4. A run that is not progressing is closed after the expiry window (default 15 min, configurable): a `requested` row older than it, or a `fetching`/`stored` row whose claim lease lapsed longer ago than it (the worker died; its redelivery was skipped while the lease was live). It is marked `failed` with `failure_kind=expired` (it still counts as transient for retry) so a lost message or dead worker frees its slot.
- Contracts:
  - Migration `017_ingestion_job_tracking.sql` (015 and 016 were taken by the time of implementation; `migrate.ts` applies files in name order, so the duplicate 006 and 015 prefixes sort fine and 017 runs last): add `trigger` (`schedule|retry|manual`, default `manual`), `started_at`, `completed_at`, `failure_kind` (`transient|permanent|expired`), `retry_of` (nullable run id, for retry accounting); extend the `status` CHECK with `requested`; index on `(source, ecosystem) WHERE status IN ('requested','fetching','stored')`; create `scheduler_leases` table; create `sentra_scheduler` NOLOGIN role with SELECT/INSERT/UPDATE on `ingestion_runs` and the lease table; `task stack:scheduler-role` sets the local password (mirrors `crawler-role`).
  - `crawl.failed`: **v2** adds required `failureKind` (`transient|permanent`); v1 stays on disk. Resolved at implementation: `packages/contracts/events.md` says unknown fields are rejected (`additionalProperties: false`) and that adding a field means a new version, and ADR 0002 says a breaking change means a new version, so an additive field under v1 is not allowed. The crawler emits v2 only; a consumer that meets a v1 `crawl.failed` (older crawler) treats it as `permanent`. No consumer of `crawl.failed` exists yet, so nothing needed migrating. `contracts.validate` takes an explicit `version`.
  - `crawl.requested.v1`: unchanged.
- Compatibility: manual `crawler.request` keeps working; its runs have no pre-inserted row, so the claim `INSERT ... ON CONFLICT` still creates them with `trigger=manual`.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | 3 sources: about 24 + 24 + 4 = 52 requests/day plus retries | Derived from the default cadence | Counter `scheduler_requests_total` |
| Concurrent users or jobs | At most 2 active runs per source + ecosystem, 6 total at default config | Cap decision | `scheduler_active_runs` gauge |
| Data size and growth | About 52 rows/day in `ingestion_runs` (about 19k/year) | Derived | Revisit retention if rows exceed 1M; no purge now |
| Latency or throughput target | Scheduled request published within 1 tick (default 30s) of becoming due | **Assumed** | Integration test with short intervals |
| Availability and recovery target | If the scheduler is down, data goes stale but nothing is lost; on restart it resumes from lease state (due sources fire once, no catch-up burst) | **Assumed**, no SLO set | Restart test |

Freshness SLO per source: **Unknown**; not provided. The cadence above is a stated assumption.

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Duplicate input / redelivered `crawl.requested` | Same `runId` resolves to the same row via claim (existing behavior); no second fetch | Existing SENTRA-7 test + requested-row variant |
| Two scheduler replicas tick together | Lease means exactly one inserts and publishes per due tick | Integration test with two scheduler instances |
| Source at cap | Tick skipped, `scheduler_ticks_skipped_total{reason="cap"}` incremented, warning logged | Integration test |
| Upstream down / 5xx / 429 | Crawler fails run as `transient`; scheduler retries at 1/5/15 min, then waits for next tick | Integration test with fake server |
| Upstream 404 or malformed artifact | `permanent`; no retry; metric + error log | Integration test |
| Request lost (Kafka down before publish succeeds, message dropped) | Row stays `requested`; expires after window, frees slot, retried as transient. A publish error at insert time marks the row failed immediately | Integration test |
| Retry of a failed job | New `runId`; content-addressed storage and ETag mean no duplicate or corrupted normalized data (downstream consumers are already idempotent per ADR 0002) | Retry-after-partial test; pipeline re-consumption check |
| Scheduler crash between insert and publish | Same as lost request: expires and retries | Kill test |
| Clock skew between replicas | Intervals evaluated from DB `now()` and lease timestamps, not process clocks | Code review + test with skewed local clock |
| Tenant boundary and unauthorized access | Runs are global reference data with no tenant data; scheduler has its own least-privilege role; no new network surface | Role grant test (cannot touch tenant tables) |
| Kill switch | `SCHEDULER_ENABLED=false` publishes nothing and writes no rows; process logs that it is disabled and exits cleanly | Test |

## Security, observability, and rollout

- Authorization, tenant isolation, sensitive data, abuse limits:
  - Scheduler uses the same event-signing key as `crawler.request` (existing `keyId` mechanism); the key is read from env, never logged.
  - `sentra_scheduler` grants limited to `ingestion_runs` and `scheduler_leases`.
  - Abuse limits are the per-source cap and the retry bound (max 3 per failure chain).
  - No tenant data and no new inbound endpoints.
- Logs, metrics, traces, alerts:
  - Logs follow `packages/contracts/logging.md` with `runId`, `correlationId`, `source`, `ecosystem`, `trigger`.
  - Metrics (Prometheus, `scheduler_` prefix): `requests_total{source,trigger}`, `ticks_skipped_total{source,ecosystem,reason}` (reason `cap` or `retry_cap`), `active_runs{source,ecosystem}`, `retries_total{source}`, `last_success_timestamp_seconds{source,ecosystem}`, `failures_total{source,kind}`.
  - Suggested alert (not wired until SENTRA-23): last success older than 3x interval.
- Rollout, migration, rollback, operational owner:
  - Migration is additive; existing rows backfill `trigger=manual`. Roll out migration and crawler change first, then enable the scheduler. Rollback: stop the scheduler (kill switch); the crawler change is backward compatible.
  - Operator: platform owner. Runbook goes in `services/crawler/README.md` (running, disabling, reading `crawler:runs`).

## Acceptance criteria

- [ ] Each configured source/ecosystem is requested on its configured interval.
- [ ] A run record holds source, start time, completion time, status, and failure kind and message.
- [ ] Concurrent runs for a source never exceed the configured cap; skipped ticks are visible in logs and metrics.
- [ ] A failed run is retried (transient only, 1/5/15 min, max 3) with no duplicated or corrupted normalized data.
- [ ] `task crawler:runs` lists recent runs per source; metrics expose last success, active runs, skips and retries.
- [ ] `SCHEDULER_ENABLED=false` stops scheduling entirely.
- [ ] Replacing the scheduler requires only emitting a valid `crawl.requested`; no adapter or crawler-worker code depends on the scheduler.
- [ ] Two scheduler replicas do not double-request.
- [ ] A lost request expires and frees its slot.

## Verification

- Manual checks and expected results: `task stack:up`; start the scheduler with 1-minute intervals and confirm rows move `requested -> fetching -> published/unchanged` and appear in `task crawler:runs`; point a source at a failing fake upstream and observe retries at the configured delays then stop; run with `SCHEDULER_ENABLED=false` and confirm no rows or messages.
- Automated tests and what they prove (`task crawler:test`, `task crawler:test:integration`, real Postgres/Redpanda per existing conftest): tick/cap (including under concurrent replicas)/row-lock logic, retry schedule and classification, expiry, two-replica exclusivity, kill switch, migration 017 against existing rows, `Runs.claim` accepting `requested`.
- Load or failure tests: kill the scheduler between insert and publish; stop Redpanda during a tick.
- Also: `task check:full` including `task fallow`.

## Implementation deviations and notes

1. Retries are read from `ingestion_runs.failure_kind`, not from a `crawl.failed` consumer (durable across scheduler outages, no consumer group, indifferent to the v1/v2 mix).
2. Only `schedule` and `retry` runs are retried. Failed manual runs are not, and neither are runs started by an external orchestrator: those arrive as `trigger=manual` because the worker creates their row.
3. A retry blocked by the cap stays due and goes out when a slot frees; each blocked pass is counted (`ticks_skipped_total{reason="retry_cap"}`) and logged as `retry deferred`. An exhausted chain is logged at info.
4. `retry_of` points at the first run of a failure chain (the chain root), which bounds retries per chain.
5. Runs closed by the scheduler (`expired`, or failed on publish error) emit no `crawl.failed` event; they exist only in `ingestion_runs`, logs and metrics.
6. `retry_of` is a foreign key with no `ON DELETE`: a future retention purge must delete whole chains (children first).
7. Review round 1 (R1): a worker that dies mid-run leaves a `fetching` row whose redelivery is skipped, so expiry also closes `fetching`/`stored` rows whose lease lapsed more than the expiry window ago, as `expired` (retried as transient). Tested.

## Open questions and assumptions to validate

- Cap of 2, expiry of 15 min, tick of 30s, and retry delays are assumptions; validate after one week of real runs.
- Freshness requirement per source is unknown; cadence is an assumption.
- ~~Whether `crawl.failed` can take an additive field under `v1`~~ Resolved: needs v2 (see Contracts).
- Operator API/UI for run status: follow-up story to create.
- Run retention/purge: not needed at about 19k rows/year; revisit later (see note 6).
- `scheduler_failures_total` is per process since start (use `max()` across replicas); `ghsa` is not scheduled by default (needs a token); an unsupported source in `schedules.toml` is not rejected at load (the crawler drops it and the run expires).
