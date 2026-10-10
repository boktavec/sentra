# SENTRA-10: Scheduling and tracking ingestion jobs

## What was built

A `crawler.scheduler` process that requests each configured source on an interval, a richer `ingestion_runs` record (start, completion, trigger, failure kind), a per-source cap on active runs, automatic retry of transient failures, expiry of lost runs, and `task crawler:runs` plus metrics for inspection. `SCHEDULER_ENABLED=false` turns it off. See [ADR 0010](../adr/0010-scheduler-as-event-publisher-with-capped-runs.md) and the [spec](../features/SENTRA-10-schedule-track-ingestion-jobs/spec.md).

## Why it is designed this way

- **The event is the seam.** The scheduler only publishes signed `crawl.requested`. The crawler and adapters never import it, so swapping in Airflow or Temporal later means emitting the same event.
- **The database is the coordinator.** A job row exists before the message does, so "how many are active" and "was anything lost" are SQL questions, not broker questions. A row lock serializes replicas, and the DB clock avoids clock skew between them.
- **Retries are new runs.** A retry gets a new `runId`; content-addressed storage and conditional GETs make repeating a fetch harmless, so retrying cannot corrupt normalized data.

## Alternatives considered

API-embedded timer, external cron, a second table, a `crawl.failed` consumer, and unbounded or skip-while-active concurrency. Each is weighed in the ADR.

## Tradeoffs

Overlap is allowed (a stuck run should not freeze a source), so a cap bounds it. Expiry trades a little wasted work for never wedging a source. Config in a file means cadence changes need a deploy, in exchange for no operator write path or auth.

## Scaling implications

About 52 requests/day at the default cadence, so volume is trivial. The scheduler is horizontally safe, but per-tick queries scan a source's rows; add a `completed_at` index or time bound if the table nears 1M rows.

## Failure and security considerations

- A crash between insert and publish leaves a `requested` row that expires and is retried.
- A worker that dies mid-run held a cap slot forever until expiry was extended to claimed runs. The reviewer's reproduction caught this; it is the best example of why leases need an owner-death story.
- A worker frozen past its lease can still emit its event; consumers must be idempotent.
- `sentra_scheduler` can touch only `ingestion_runs` and `scheduler_leases`, and runs hold no tenant data.

## Key concepts

Row-lock leader election, at-least-once delivery with idempotent consumers, leases that expire when their owner dies, backpressure by capping work in flight, and keeping an orchestrator behind an event contract so it can be replaced.
