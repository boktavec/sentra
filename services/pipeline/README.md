# services/pipeline

Python data pipeline with two jobs: validate tenant-uploaded SBOMs and parse their components into dependency records, and normalize raw vulnerability artifacts into the canonical model (below). Design: [SENTRA-5 spec](../../docs/features/SENTRA-5-upload-sbom/spec.md), [SENTRA-6 spec](../../docs/features/SENTRA-6-parse-sbom-dependencies/spec.md) and [ADR 0002](../../docs/adr/0002-event-conventions-for-async-ingestion.md); vulnerabilities: [SENTRA-11 spec](../../docs/features/SENTRA-11-normalize-vulnerabilities/spec.md) and the [canonical models](../../packages/contracts/models.md).

## Flow

`sbom.uploaded` -> validate against the schema -> load the `sbom_imports` row -> read the object -> check -> parse -> `parsed` or `rejected(reason)`.

- The `sbom_imports` row is authoritative. The object key comes from the row, never from the event, so an event cannot point the pipeline at another tenant's file.
- Only `uploaded` imports are processed. The result is written with `WHERE status = 'uploaded'`, so a duplicate or concurrent delivery changes nothing.
- Reading is capped at `PIPELINE_MAX_SBOM_BYTES` (default 10 MiB) and never holds more than that in memory.
- Storage and database failures are retried with backoff (5 attempts, 1 s doubling to 30 s), then recorded as `rejected(processing_failed)`. The offset is committed either way, so a poison event cannot block the partition. If even that record cannot be written, the offset stays uncommitted and the event is redelivered.
- The database role `sentra_pipeline` can read `sbom_imports`, update only `status`, `reason_code`, `size_bytes`, `sha256`, `updated_at`, `dependency_count` and `skipped_count`, and read, insert and delete `sbom_dependencies`.

## Parsing (SENTRA-6)

- One `sbom_dependencies` row per canonical purl per import, nested components included. Duplicates merge: `occurrences` counts them and `scope` keeps the strictest (`required` over `optional` over `excluded`).
- A component needs a valid purl **with a version** to become a dependency. Others are counted in `skipped_count`, never stored.
- `ecosystem` is the OSV ecosystem for the purl type (`npm`, `PyPI`, `Maven`, `Go`, `crates.io`, `NuGet`, `RubyGems`, `Packagist`, `Hex`, `Pub`); other types are stored with `ecosystem = NULL`.
- Status, counts and rows are written in one transaction guarded by `WHERE status = 'uploaded'`: all or nothing, and a duplicate delivery writes nothing.
- More than `PIPELINE_MAX_COMPONENTS` (default 50,000, **assumed**) components, or no usable component, is a rejection and the raw file stays in storage.
- **Reprocess** without re-uploading: `task api:sbom:reprocess IMPORT_ID=<uuid>` (operator only). It clears the import's dependencies, sets it back to `uploaded` and queues a fresh `sbom.uploaded`.
- Known limitation: `bom-ref` and the dependency graph are not kept.

Reason codes: `size`, `not_json`, `not_cyclonedx`, `unsupported_version`, `no_components`, `too_many_components`, `processing_failed`.

## Supported CycloneDX versions

JSON with `bomFormat: "CycloneDX"` and `specVersion` 1.4, 1.5, 1.6 or 1.7. **Verified** 2026-10-08 through the cyclonedx-python-lib and cyclonedx-cli docs (context7): the spec has versions 1.0 to 1.7, and JSON exists from 1.2 on. 1.2 and 1.3 are rejected as `unsupported_version` until a user needs them. The test fixture `tests/fixtures/cyclonedx-1.6.json` is valid against the official 1.6 JSON schema.

## Run locally

```sh
task stack:up                 # Postgres, Redpanda, SeaweedFS, ...
task api:dev                  # the API applies migrations on startup (sbom_imports, sentra_pipeline role)
task stack:pipeline-role      # gives that role its local password
task pipeline:run             # copies .env.example to .env on first run
```

Metrics are on `127.0.0.1:9103/metrics` (`sbom_validation_total{outcome}`, `sbom_validation_duration_seconds`, `sbom_dependencies_per_import`, `sbom_validation_retries_total`, `pipeline_worker_errors_total`). Consumer lag: `rpk group describe pipeline-sbom`.

## Vulnerability normalizer (SENTRA-11)

A second process (`pipeline.normalize`, consumer group `normalizer-artifacts`) with its own Postgres role, `sentra_normalizer`, which cannot read any tenant table.

`artifact.ingested` -> validate the event -> check the object key is exactly `raw/<source>/<ecosystem>/<sha256>.zip` (`.json` for KEV) -> claim the run -> download to a temp file and verify the SHA-256 -> stream the zip -> adapter -> validate against `vulnerability.v1.json` -> upsert in batches -> `vulnerabilities.normalized`.

- Source adapters (`normalize/adapters/osv.py`, `kev.py`) are the only code that knows a source's shape. KEV is one JSON document, not a zip, so `process._pass_kev` writes `kev_entries` and tombstones in one transaction (see [ADR 0005](../../docs/adr/0004-kev-as-enrichment-plus-linked-vulnerability-rows.md)); `NORMALIZER_KEV_MAX_REMOVAL_RATE` is the operator override for a legitimate large removal.  Validation, persistence and the worker see only the canonical record.
- A row is rewritten only if the source's `modified` is newer or `ADAPTER_VERSION` is higher, so reprocessing the same artifact changes nothing. After changing what the adapter produces, bump `ADAPTER_VERSION` and run `task pipeline:normalize:reprocess -- <ecosystem>`: it rewrites every row from the raw artifact.
- A record that fails normalization or validation is stored in `normalization_failures` (artifact SHA-256, zip entry, error) and the run continues. If more than 1% of at least 1,000 records fail (**assumed**), the run is marked `failed` and no event is sent.
- Zip limits (entries, bytes per entry, total bytes) are checked on declared and actual sizes; a tripped limit fails the run before any later entry is read.
- One run per artifact and adapter version in `normalization_runs`, with a lease renewed on every batch. A crash after the last batch and before the event is recovered when `artifact.ingested` is redelivered. An outage releases the run and the event is retried until it passes.
- Measured 2026-10-08 on a laptop against the real dumps: PyPI (26,143 records) 8.7 s, npm (230,171 records) 37.6 s, peak memory under 450 MiB. Re-running either with different zip bytes and identical records rewrites zero rows.

Metrics are on `127.0.0.1:9104/metrics` (`normalize_artifacts_total{outcome}`, `normalize_records_total{outcome}`, `normalize_run_duration_seconds`, `normalize_retries_total`, `normalizer_worker_errors_total`). Consumer lag: `rpk group describe normalizer-artifacts`. Run it with `task stack:normalizer-role` once, then `task pipeline:normalize:run`. Settings are the `NORMALIZER_*` variables in `.env.example`.

## Tests

```sh
task pipeline:test              # unit, no stack needed
task pipeline:test:integration  # needs the stack; uses a scratch database and bucket
```

Integration tests default to the compose ports; set `TEST_ADMIN_DATABASE_URL`, `TEST_S3_ENDPOINT` or `TEST_KAFKA_BOOTSTRAP` if yours differ.

## Correlator (SENTRA-13)

A third process (`pipeline.correlate`, consumer group `correlator`) with its own Postgres role, `sentra_correlator`: it reads dependencies and advisories and writes only `findings`, `match_runs` and `correlation_state`. Design: [SENTRA-13 spec](../../docs/features/SENTRA-13-match-dependencies/spec.md) and [ADR 0003](../../docs/adr/0003-findings-as-derived-state-reconciled-per-project.md).

Three triggers, one function. `reconcile(project)` takes a per-project advisory lock, recomputes the project's findings from its newest `parsed` import and the current advisories, writes only rows that changed, and resolves the rest with a reason.

- `sbom.parsed` -> reconcile that import's project (tenant and project come from the `sbom_imports` row, never the event).
- `vulnerabilities.normalized` -> reconcile every project whose latest import names a package of an advisory changed since the watermark.
- A sweep every `CORRELATOR_SWEEP_INTERVAL_SECONDS` (default 24h) reconciles every project, in batches between Kafka polls. It heals lost events. `task pipeline:correlate:sweep` runs one now (after a matcher change or an outage).

Run it with `task pipeline:correlate:run` after `task stack:correlator-role`. Metrics are on `CORRELATOR_METRICS_PORT` (9105). `task pipeline:correlate:bench` times matching on real advisories and synthetic tenants.

## Advisory grouper (SENTRA-12)

`python -m pipeline.group` links advisories that describe the same issue. It polls `vulnerabilities.updated_at` (watermark in `group_state`, 5-minute overlap), takes the whole alias component around each changed advisory plus the groups it used to be in, and writes `vulnerability_groups`, `vulnerability_group_members` and `group_conflicts`. It only reads advisories; the correlator is untouched.

- Rule: advisories sharing an identifier (own id or alias) are one group. A component with more than one CVE id, or whose advisories share no affected package, is refused: every member stays a singleton and gets a `group_conflicts` row.
- Group id = UUIDv5 of the canonical member (smallest `(source, source_id)` among advisories that list packages, so KEV stubs never lead), so a rebuild gives the same ids. A group merged away keeps its row with `merged_into`.
- Run: `task pipeline:group:run` after `task stack:grouper-role` (`-- --once` for one pass). To rebuild after a rule change: `DELETE FROM group_state`, then run once. Metrics on `GROUPER_METRICS_PORT` (9106); each pass is a row in `group_runs`.
- Known limits: see the SENTRA-12 spec and `docs/adr/0005-advisory-groups-over-advisories.md`.

## Configuration

See `.env.example`. `PIPELINE_MAX_SBOM_BYTES` must be at least the API's upload cap.
