# 0010: Ingestion scheduling is an event publisher over a run table, with capped overlap

- Status: Accepted
- Date: 2026-10-09
- Related: [SENTRA-10 spec](../features/SENTRA-10-schedule-track-ingestion-jobs/spec.md), [ADR 0002](0002-event-conventions-for-async-ingestion.md)

## Context

Ingestion started only from a manual `crawler.request`. The MVP needs recurring, tracked, bounded, retryable ingestion without adopting an orchestration platform, and without coupling source adapters to whatever schedules them.

## Decision

- A separate `crawler.scheduler` process reads a versioned `schedules.toml` and publishes signed `crawl.requested` events through the existing `request.build`. The event contract is the only seam to the crawler, so any orchestrator that emits a valid request can replace it.
- `ingestion_runs` is the job record. The scheduler inserts a `requested` row before publishing; the crawler's claim moves it to `fetching`. Start/completion times, trigger, failure kind, and the retry chain root are columns on that row (migration 017).
- Replicas coordinate with a row lock on `scheduler_leases` held for the due check, the cap check, and the insert; nothing is published while the lock is held. All comparisons use the database clock.
- Overlap per source+ecosystem is allowed but capped (default 2 active). A tick at the cap is skipped, logged, and counted.
- Retries read `ingestion_runs.failure_kind`, not a Kafka consumer: transient failures are re-requested with a new `runId` at 1/5/15 minutes, at most 3 per chain. Permanent and manual-run failures are not retried.
- Runs that stop progressing (an unclaimed request, or a claimed run whose lease lapsed 15 minutes ago) are closed as `failed`/`expired`, which frees their cap slot and makes them retryable.
- `crawl.failed` moves to v2 with a required `failureKind`, per ADR 0002's versioning rule.
- Operators inspect runs with `task crawler:runs`, Prometheus metrics, and logs. There is no API; a platform-operator authorization model needs its own story.

## Alternatives considered

- Scheduler inside the API process: no new process, but ties ingestion cadence to API deploys and scaling and moves the signing key into the API.
- External cron: no code, but schedules live outside the repo and cannot be inspected or disabled per source.
- Separate `scheduled_runs` table: leaves the crawler alone, but splits one job across two tables.
- Retry via a `crawl.failed` consumer: equivalent, but adds a consumer group and misses failures while the scheduler is down. The table is already authoritative.
- Skip-while-active or unbounded overlap: skip-while-active lets a wedged run block a source; unbounded gives no protection from pile-ups.

## Consequences

- The scheduler is one more process to run and watch; the stale-success alert waits for SENTRA-23.
- A run closed as `expired` may still have a late worker emit `artifact.ingested`; consumers are idempotent, so this costs duplicate work, not corruption.
- Cap, expiry, tick, retry delays, and cadence are assumptions. Revisit after a week of real runs, or when run rows approach 1M, when the per-tick scans need an index or time bound and retention must delete whole retry chains.
- Moving to Airflow/Temporal means emitting the same signed `crawl.requested` and honoring the cap and run-row insert, or accepting rows created by the claim with `trigger=manual`.
