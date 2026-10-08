# services/pipeline

Python data pipeline. Today it has one job: validate tenant-uploaded SBOMs. SENTRA-6 extends the same consumer to parse components into dependency records. Design: [SENTRA-5 spec](../../docs/features/SENTRA-5-upload-sbom/spec.md) and [ADR 0002](../../docs/adr/0002-event-conventions-for-async-ingestion.md).

## Flow

`sbom.uploaded` -> validate against the schema -> load the `sbom_imports` row -> read the object -> check -> `validated` or `rejected(reason)`.

- The `sbom_imports` row is authoritative. The object key comes from the row, never from the event, so an event cannot point the pipeline at another tenant's file.
- Only `uploaded` imports are processed. The result is written with `WHERE status = 'uploaded'`, so a duplicate or concurrent delivery changes nothing.
- Reading is capped at `PIPELINE_MAX_SBOM_BYTES` (default 10 MiB) and never holds more than that in memory.
- Storage and database failures are retried with backoff (5 attempts, 1 s doubling to 30 s), then recorded as `rejected(processing_failed)`. The offset is committed either way, so a poison event cannot block the partition. If even that record cannot be written, the offset stays uncommitted and the event is redelivered.
- The database role `sentra_pipeline` can read `sbom_imports` and update only `status`, `reason_code`, `size_bytes`, `sha256` and `updated_at`.

Reason codes: `size`, `not_json`, `not_cyclonedx`, `unsupported_version`, `processing_failed`.

## Supported CycloneDX versions

JSON with `bomFormat: "CycloneDX"` and `specVersion` 1.4, 1.5, 1.6 or 1.7. **Verified** 2026-10-08 through the cyclonedx-python-lib and cyclonedx-cli docs (context7): the spec has versions 1.0 to 1.7, and JSON exists from 1.2 on. 1.2 and 1.3 are rejected as `unsupported_version` until a user needs them. The test fixture `tests/fixtures/cyclonedx-1.6.json` is valid against the official 1.6 JSON schema.

## Run locally

```sh
task stack:up                 # Postgres, Redpanda, SeaweedFS, ...
task api:dev                  # the API applies migrations on startup (sbom_imports, sentra_pipeline role)
task stack:pipeline-role      # gives that role its local password
task pipeline:run             # copies .env.example to .env on first run
```

Metrics are on `127.0.0.1:9103/metrics` (`sbom_validation_total{outcome}`, `sbom_validation_duration_seconds`, `sbom_validation_retries_total`, `pipeline_worker_errors_total`). Consumer lag: `rpk group describe pipeline-sbom`.

## Tests

```sh
task pipeline:test              # unit, no stack needed
task pipeline:test:integration  # needs the stack; uses a scratch database and bucket
```

Integration tests default to the compose ports; set `TEST_ADMIN_DATABASE_URL`, `TEST_S3_ENDPOINT` or `TEST_KAFKA_BOOTSTRAP` if yours differ.

## Configuration

See `.env.example`. `PIPELINE_MAX_SBOM_BYTES` must be at least the API's upload cap.
