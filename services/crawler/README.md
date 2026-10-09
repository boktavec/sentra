# services/crawler

Python data acquisition service. Fetches external security data, stores the raw artifact untouched, and publishes an event for the pipeline. It never parses the data it fetches. Design: [SENTRA-7 spec](../../docs/features/SENTRA-7-ingest-osv/spec.md) and [ADR 0002](../../docs/adr/0002-event-conventions-for-async-ingestion.md).

## Flow

`crawl.requested` (signed) -> verify -> claim run -> conditional GET -> store `raw/<source>/<ecosystem>/<sha256>.zip` -> `artifact.ingested`. Permanent failures publish `crawl.failed`. Contracts: [`packages/contracts/events.md`](../../packages/contracts/events.md).

## Run locally

```sh
task stack:up                 # Postgres, Redpanda, SeaweedFS, ...
task api:dev                  # the API applies migrations on startup (ingestion_runs, sentra_crawler role)
task stack:crawler-role       # gives that role its local password
task crawler:run              # copies .env.example to .env on first run
```

Create the request topic once (`rpk topic create crawl.requested` in the Redpanda container) and publish a signed event (see `signing.sign`). Metrics are on `127.0.0.1:9102/metrics` (set `CRAWLER_METRICS_HOST=0.0.0.0` in a container so Prometheus can scrape it); consumer lag via `rpk group describe sentra-crawler`.

## Tests

```sh
task crawler:test              # unit, no stack needed
task crawler:test:integration  # needs the stack; uses a scratch database and bucket
```

Integration tests default to the compose ports; set `TEST_ADMIN_DATABASE_URL`, `TEST_S3_ENDPOINT` or `TEST_KAFKA_BOOTSTRAP` if yours differ.

## Configuration

See `.env.example`. Source URLs (`CRAWLER_OSV_BASE_URL`, `CRAWLER_KEV_URL`) are operator config and must be https (http only for loopback); events never carry URLs.
