# services/crawler

Python data acquisition service. Fetches external security data, stores the raw artifact untouched, and publishes an event for the pipeline. It never parses the data it fetches. Design: [SENTRA-7 spec](../../docs/features/SENTRA-7-ingest-osv/spec.md) and [ADR 0002](../../docs/adr/0002-event-conventions-for-async-ingestion.md).

## Flow

`crawl.requested` (signed) -> verify -> claim run -> conditional GET -> store `raw/<source>/<ecosystem>/<sha256>.zip` -> `artifact.ingested`. Failures publish `crawl.failed` (v2, with `failureKind` `transient` or `permanent`). Contracts: [`packages/contracts/events.md`](../../packages/contracts/events.md).

## Run locally

```sh
task stack:up                 # Postgres, Redpanda, SeaweedFS, ...
task api:dev                  # the API applies migrations on startup (ingestion_runs, sentra_crawler role)
task stack:crawler-role       # gives that role its local password
task crawler:run              # copies .env.example to .env on first run
```

Create the request topic once (`rpk topic create crawl.requested` in the Redpanda container) and publish a signed event (see `signing.sign`). Metrics are on `127.0.0.1:9102/metrics` (set `CRAWLER_METRICS_HOST=0.0.0.0` in a container so Prometheus can scrape it); consumer lag via `rpk group describe sentra-crawler`.

## Scheduler

`crawler.scheduler` requests every source in [`schedules.toml`](schedules.toml) on its interval (default: OSV npm and PyPI hourly, `cisa-kev` every 6h). It only publishes signed `crawl.requested` events, so any other orchestrator that does the same can replace it. Design: [SENTRA-10 spec](../../docs/features/SENTRA-10-schedule-track-ingestion-jobs/spec.md).

```sh
task stack:scheduler-role      # once: gives the sentra_scheduler role (migration 017) its local password
task crawler:scheduler         # metrics on 127.0.0.1:9103
task crawler:runs              # recent runs per source; --status failed, --source osv, --limit 20
```

How it behaves:

- Each tick it records a `requested` run in `ingestion_runs` and publishes the request; the worker claims it (`fetching`), then it ends `published`, `unchanged` or `failed`. `started_at`, `completed_at`, `failure_kind` and `error` say when and why.
- At most `SCHEDULER_MAX_ACTIVE_RUNS` (default 2) runs are active per source + ecosystem; a due tick above that is skipped, logged as `tick skipped` and counted in `scheduler_ticks_skipped_total{reason="cap"}`.
- Several replicas are safe: one row per schedule in `scheduler_leases` makes exactly one of them fire a due tick. After a restart, a due source fires once (no catch-up burst).
- A `transient` failure (upstream 5xx/429/timeout/rate limit, or a lost request) is retried with a new `runId` after 1, 5 and 15 minutes, then waits for the next tick. `permanent` failures (404, wrong file type, unsupported source, a bug) and failed manual runs are not retried. Failures older than an hour are not retried.
- A run that is not progressing is marked `failed` with `failure_kind=expired` (counts as transient, so it is retried), which frees its slot: a request nobody claimed within `SCHEDULER_EXPIRY_SECONDS` (default 900), or a claimed run whose worker died and whose lease lapsed that long ago. A redelivery of a closed run is skipped. A worker frozen past its lease can still emit its `artifact.ingested` event; consumers are idempotent, so the retry's duplicate artifact is harmless.
- Metrics (the skip, active-runs and last-success series carry `source` and `ecosystem`): `scheduler_requests_total`, `scheduler_ticks_skipped_total{reason=cap|retry_cap}`, `scheduler_active_runs`, `scheduler_retries_total`, `scheduler_last_success_timestamp_seconds`, `scheduler_failures_total{kind}`, `scheduler_loop_errors_total`. `scheduler_failures_total` counts what each process saw since it started, so with replicas use `max()`. Suggested alert (not wired until SENTRA-23): last success older than 3x the interval.

Operating it:

- **Disable:** `SCHEDULER_ENABLED=false` (the process logs that it is disabled and exits; nothing is published or written). Re-enable by setting it back and starting the process.
- **Change cadence:** edit `schedules.toml` and restart. A shorter interval applies from the next due time of the old one.
- **Rollout order:** apply migration 017 and deploy the crawler worker first (it is backward compatible), then start the scheduler. Rollback: kill switch; the worker change stays.
- **Stuck source:** `task crawler:runs -- --source osv` shows `requested` rows that are not progressing and `fetching` rows that are (both are closed automatically if they stall).
- **Retries blocked by the cap** are logged as `retry deferred` and go out when a slot frees; an exhausted chain logs `retry chain exhausted`.

## Tests

```sh
task crawler:test              # unit, no stack needed
task crawler:test:integration  # needs the stack; uses a scratch database and bucket
```

Integration tests default to the compose ports; set `TEST_ADMIN_DATABASE_URL`, `TEST_S3_ENDPOINT` or `TEST_KAFKA_BOOTSTRAP` if yours differ.

## Configuration

See `.env.example`. Source URLs (`CRAWLER_OSV_BASE_URL`, `CRAWLER_KEV_URL`) are operator config and must be https (http only for loopback); events never carry URLs.

`CRAWLER_GITHUB_TOKEN` is required only for `ghsa` runs (a run without it fails before any request). It is held in a redacting `Secret`, sent only to `https://api.github.com` (the GitHub API origin is not configurable), and never logged, published, or written to the artifact sidecar. `ghsa` pages the REST advisories API into one zip of unmodified page bodies and resumes from a per-run watermark (`ingestion_runs.watermark`); see the [SENTRA-9 spec](../../docs/features/SENTRA-9-ingest-ghsa/spec.md).
