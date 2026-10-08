# SENTRA-11: Normalize vulnerability records

- Status: Approved (implemented; see Implementation notes)
- YouTrack: http://localhost:8080/issue/SENTRA-11 ("[MVP] Normalize Vulnerability Records")
- Owner: Sentra operator / project owner

## Problem and outcome

- Raw OSV dumps are stored by the crawler (SENTRA-7) but nothing reads them. Correlation (SENTRA-12), matching (SENTRA-13), the UI, APIs and AI tools need one provider-independent model, not OSV's schema.
- Done means: `artifact.ingested` for an OSV ecosystem causes the pipeline to stream the raw zip, convert each advisory into the canonical model, validate it, and upsert it into Postgres with provenance. Bad records are quarantined and traceable to the artifact. Reprocessing the same artifact changes nothing. A `vulnerabilities.normalized` event is published when the artifact is done.

## Scope

- In scope:
  - Canonical vulnerability model, documented, with a Postgres schema (API migration).
  - OSV adapter (npm, PyPI) in `services/pipeline`, kept separate from domain and persistence code.
  - Streaming zip reader with decompression limits; per-record validation; quarantine table; failure-rate abort.
  - `schema_version` / `adapter_version` stamping and an operator reprocess task.
  - `vulnerabilities.normalized` event contract.
  - **Documented only:** CISA KEV and GitHub (GHSA) mappings to the canonical model.
- Out of scope (documented, not built):
  - KEV and GHSA adapters (SENTRA-8, SENTRA-9, once real artifacts exist).
  - Deduplicating or correlating across sources (SENTRA-12); an OSV alias is stored, not resolved.
  - Version comparison and dependency matching (SENTRA-13).
  - Freshness SLO (SENTRA-26), alerting (SENTRA-23), scheduling (SENTRA-10), warehouse export.
- Dependencies: depends on SENTRA-7 (Done). Feeds SENTRA-12 and SENTRA-13. Sets the adapter pattern for SENTRA-8 and SENTRA-9.

## Decisions and alternatives

OSV facts were checked on 2026-10-08 against the live PyPI `all.zip` (35,710,808 bytes) and are marked **Verified**.

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Scope of sources | OSV adapter built; KEV and GHSA models documented, mappings **Assumed** | All three adapters on hand-fetched samples; OSV + KEV | No real KEV/GHSA artifacts exist until SENTRA-8/9. The first two AC bullets are only partly met until then. |
| Storage | Postgres tables, global data, no `tenant_id` | Normalized JSON in object storage; warehouse | SENTRA-13 needs an indexed join to `sbom_dependencies`. Warehouse export revisited when analytics need it. |
| Affected versions | Store normalized range events plus the explicit `versions` list; drop `GIT` ranges | Pre-computed intervals; versions list only | Faithful to the source and cheap to evolve. Version comparison stays in SENTRA-13. A versions-only model would lose data (see facts). |
| Bad records | Quarantine in `normalization_failures`, continue | All-or-nothing; log only | One odd advisory must not block all updates; logs are not a durable trace. |
| Update rule | Upsert by `(source, source_id)`, applied when incoming `modified` is newer **or** `adapter_version` is higher; withdrawn kept with a flag | Content-hash only; replace whole ecosystem | Idempotent, older artifacts cannot clobber newer data, unchanged rows cause no write. KEV has no per-record `modified`, so it needs a content-hash fallback (**Assumed**). |
| Evolution | `schema_version` and `adapter_version` on every row; reprocess from raw by operator task | Table migrations only; side-by-side versions | Tells you which rows are stale after an adapter fix. Breaking model changes still need a migration. |
| Completion signal | One `vulnerabilities.normalized` event per artifact, after the last batch commits | No event; one event per advisory | Matches ADR 0002 conventions. Crash before publish is recovered by redelivery of `artifact.ingested`. |
| Zip safety | Limits while streaming, sha256 verified first, tripped limit fails the artifact | Crawler size cap only; sandboxed process | SENTRA-7 deferred zip-bomb handling here. Declared sizes can lie, so actual bytes are counted. |
| Abort rule | Abort and mark run `failed` when failure rate exceeds a threshold | Never abort; abort on first new failure kind | Stops a broken adapter from quietly replacing good data with nothing. Committed batches are idempotent and stay. |
| Processing | Stream entry by entry, batches in one transaction each; no checkpoint | Checkpointed resume | Idempotent upserts make a full restart safe; checkpointing adds state for no measured need. |

OSV facts:

- **Verified (2026-10-08):** PyPI `all.zip` has 26,143 entries, 73.2 MiB uncompressed, largest entry 73.9 KiB. Every record has `schema_version`, `id`, `published`, `modified`, `details` and `affected`. Optional: `aliases` (14,262), `summary` (21,829), `references`, `database_specific`, `severity` (11,138), `related`, `withdrawn` (597), `credits`.
- **Verified:** ID prefixes are `MAL` 11,812, `PYSEC` 7,822, `GHSA` 6,497, `OSV` 12. Almost half the records are malware reports, not CVEs.
- **Verified:** range types `ECOSYSTEM` 26,047, `GIT` 1,589, `SEMVER` 134; event keys `introduced`, `fixed`, `last_affected` only. Severity types seen: `CVSS_V3` 9,940, `CVSS_V4` 4,086 (vector strings, no score).
- **Verified:** 5,529 `affected` entries have no `ranges` and 7,213 have no `versions`, so both must be stored.
- **Verified (2026-10-08):** npm `all.zip` has 230,171 entries, 367.9 MiB uncompressed, largest entry 1.1 MiB; 222,368 are `MAL-`, 7,801 `GHSA-`. Range types: `SEMVER` 219,252, `ECOSYSTEM` 443, `GIT` 2. Same field set as PyPI, plus `schema_version` 1.7.3 to 1.9.0. Adapter and validator accepted all 256,314 records of both dumps with zero failures.
- **Verified:** 47 advisories appear in both the PyPI and npm dumps; all 47 are byte-identical (each file carries the full `affected` list), so keying on `(source, source_id)` across ecosystems loses nothing.
- **Assumed:** KEV and GHSA mappings below. Validate against real artifacts in SENTRA-8/9.

## Architecture and contracts

- Components: `services/pipeline` (new `adapters/osv.py`, canonical model, persistence, zip reader, `artifact.ingested` worker, reprocess task); `apps/api/migrations` (tables, role grants); `packages/contracts/events/` (new event, model doc).
- Flow:

```text
artifact.ingested -> validate event -> claim artifact (lease on sha256)
  -> read raw/osv/<eco>/<sha256>.zip from storage, verify sha256, check zip limits
  -> for each entry: OSV adapter -> canonical record -> validate
       ok      -> batch (500) -> upsert guarded by modified / adapter_version
       invalid -> normalization_failures (sha256, entry, error, adapter_version)
     failure rate over threshold -> run failed, stop
  -> run completed -> publish vulnerabilities.normalized
```

- The adapter maps OSV JSON to a source-free `Vulnerability` dataclass. Persistence and validation take only that type and never import OSV code.
- Canonical model (tables are global, snake_case):
  - `vulnerabilities`: `id` PK, `source`, `source_id` (UNIQUE together), `aliases[]`, `summary`, `details`, `published_at`, `modified_at`, `withdrawn_at`, `severity` (type + vector, as given), `references` (jsonb), `source_artifact_sha256`, `source_entry`, `schema_version`, `adapter_version`, `updated_at`.
  - `vulnerability_affected`: per package: `vulnerability_id`, `ecosystem`, `package_name`, `purl`, `versions[]`.
  - `vulnerability_ranges`: `affected_id`, `range_type` (`SEMVER`|`ECOSYSTEM`), ordered `event_type` (`introduced`|`fixed`|`last_affected`) and `event_version`.
  - `normalization_runs`: one per artifact sha256: `status` (`running`|`completed`|`failed`), counts (upserted, unchanged, quarantined), `claimed_until`, `error`, `adapter_version`.
  - `normalization_failures`: `artifact_sha256`, `entry_name`, `error`, `adapter_version`, `created_at`.
- Provenance preserved: original `source` and `source_id`, plus the artifact sha256 and zip entry that produced each row.
- Event `vulnerabilities.normalized` v1 (same envelope as other events): `source`, `ecosystem`, `artifactSha256`, `counts`, `adapterVersion`.
- Documented mappings (not built):
  - **CISA KEV (Assumed):** CVE ID to `source_id`; vendor/product to a non-package affected entry; `dateAdded` to `published_at`; "known exploited" is added as a flag/field for SENTRA-14; no ranges. No per-record `modified`, so the update guard uses a content hash.
  - **GHSA (Assumed):** `ghsa_id` to `source_id`; CVE/aliases to `aliases`; `vulnerabilities[].vulnerable_version_range` strings (for example `>= 1.0, < 1.4.2`) parsed into the same range events.
- Compatibility: new tables and event only. Rollback is stopping the worker and dropping the tables; raw artifacts stay.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Records per artifact | PyPI 26,143 | **Verified** 2026-10-08 | Profile npm zip before finalizing limits |
| Uncompressed size | PyPI 73.2 MiB | **Verified** | Profile npm |
| Zip limits | 1,000,000 entries (4.3x npm), 10 MiB per entry (9x), 2 GiB total (5.4x) | Set from the **Verified** npm profile; the multiples are **Assumed** headroom | Oversize tests; revisit when npm passes about half of a limit |
| Memory | Under 512 MiB: stream entries, never load the whole zip | **Assumed** cap | **Measured** 2026-10-08: peak under 450 MiB on npm, including the test harness's own upload overhead |
| Batch size | 500 records per transaction | **Assumed** | Measure run time and lock behavior |
| Failure-rate abort | More than 1% once at least 1,000 records are seen | **Assumed** | Test with a broken adapter fixture; revisit after real runs |
| Frequency | A handful of runs per day, one per ecosystem | **Assumed** (follows SENTRA-7) | Count events |
| Latency or throughput | **Unknown** as an SLO | Not invented | **Measured** 2026-10-08 (laptop, local Postgres and storage): PyPI 8.7 s, npm 37.6 s per full run; re-running unchanged data 26 s for npm. SENTRA-26 sets the SLO |
| Availability and recovery | **Unknown**; recovery is redelivery of `artifact.ingested` or reprocess task | Not invented | Crash-injection test |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Same artifact processed twice | Zero rows changed on the second run; one `vulnerabilities.normalized` per completed run | Integration test: run twice, compare rows and `updated_at` |
| Older artifact reprocessed after a newer one | Newer rows are not overwritten (`modified` guard) | Integration test with two artifact versions |
| Adapter version bump | Rows are rewritten even though `modified` is unchanged | Test with bumped version |
| Record fails validation (missing `id`, bad enum, bad date) | Quarantined with sha256 and entry name; the rest continue | Fixture with bad entries |
| Failure rate over threshold | Run `failed`, stop, publish nothing; committed batches stay | Fixture where most entries are bad |
| Zip exceeds entry or size limits, or sha256 mismatch | Artifact fails before upserts; logged and counted | Zip-bomb and tampered-file fixtures |
| `withdrawn` advisory | Stored with `withdrawn_at`, not deleted | Fixture |
| `GIT` range or unknown range type | `GIT` dropped; unknown types quarantined | Fixture |
| Two workers, same sha256 | Lease on `normalization_runs` so one processes | Concurrency test |
| Postgres or storage unavailable | Retried with backoff; offset left uncommitted if the failure cannot be recorded (same pattern as SBOM worker) | Stop each dependency |
| Crash after commit, before publish | `artifact.ingested` redelivery re-publishes; consumers dedupe by `eventId` | Kill-and-restart test |
| Tenant boundary | Not applicable: public, tenant-free data; no tenant column or tenant data in these tables | Schema review |

## Security, observability, and rollout

- Security: the object key comes from the event's artifact reference, but the sha256 is verified against the bytes, and the worker only reads the `raw/` prefix. Decompression limits protect the pipeline. A dedicated least-privilege DB role can read and write only the new tables. No secrets in the repo.
- Observability: structured logs with artifact sha256, ecosystem and correlation ID (`packages/contracts/logging.md`); Prometheus metrics for records by outcome, failure rate, run duration, batch retries and worker errors; consumer lag from the broker. Alerts are **Unknown** until SENTRA-23.
- Rollout: additive migration and a new consumer group; first run is a manual crawl request for PyPI. Operator owns reprocessing until SENTRA-10.

## Acceptance criteria

- [x] OSV records for npm and PyPI are normalized into the documented canonical model; KEV and GHSA mappings are documented (adapters follow in SENTRA-8/9).
- [x] The OSV adapter is separate from validation, persistence and the worker; none of those import OSV code.
- [x] Each row keeps `source`, `source_id`, artifact sha256 and zip entry.
- [x] Reprocessing the same artifact changes no rows.
- [x] Invalid records are validated out and never written to `vulnerabilities`.
- [x] Every quarantined record is traceable to its artifact sha256 and entry.
- [x] Rows carry `schema_version` and `adapter_version`, and an adapter bump migrates rows on reprocess.
- [x] Zip limits, sha256 check and failure-rate abort behave as specified.
- [x] `vulnerabilities.normalized` is published once per completed artifact.

## Verification

- Manual: bring up the stack, request a PyPI crawl, confirm rows in `vulnerabilities` with provenance and the event on the topic. Reprocess the same artifact: no changed rows. Corrupt one entry in a test zip: one `normalization_failures` row naming the sha256 and entry. Record the measured npm run time and peak memory.
- Automated: unit tests for the adapter (production-shaped fixtures from the real zip), validation, zip limits, and the upsert guard; integration tests on the compose stack for idempotency, ordering, version bump, quarantine, abort, lease and crash-before-publish.

## Open questions and assumptions to validate

- ~~Exact zip limits and batch size~~: set from the npm profile (see Workload). Batch size 500 stays **Assumed**; it was not tuned.
- Failure-rate threshold: revisit after the first real npm and PyPI runs.
- Does a stored `severity` vector need parsing to a score? Left raw here; decide in SENTRA-14 (risk priority).
- MAL- (malware) advisories are about 45% of PyPI records. Stored as ordinary advisories for now; SENTRA-12/14 may want to treat them differently.

## Implementation notes

Differences from the draft, and what was learned:

- **Own database role.** The normalizer uses `sentra_normalizer` (migration 009), not `sentra_pipeline`, so the process that opens untrusted zips cannot read tenant tables. A test asserts this.
- **No `force` flag.** Reprocessing the same adapter version only finishes a failed run or re-sends a missing event; a new adapter version is a new run and rewrites rows. `task pipeline:normalize:reprocess` takes the newest artifact for an ecosystem or an explicit SHA-256.
- **Dependency outages release the run.** A storage, Postgres or broker error marks the run `failed` (releasing the lease) and re-raises, so the offset stays uncommitted and the redelivered event retakes it at once. Unexpected errors retry 5 times in process, then fail the run and commit the offset.
- **Object key is checked, not trusted.** An `artifact.ingested` whose key is not exactly `raw/<source>/<ecosystem>/<sha256>.zip` is dropped, and the SHA-256 of the downloaded bytes must match.
- **zipfile enforces declared sizes.** A zip that declares a small entry and expands is stopped by `zipfile` itself (CRC failure) before our own byte count; both paths fail the run.
- **Not covered:** GHSA `vulnerable_version_range` parsing and KEV content-hash updates are documented in `packages/contracts/models.md`, not built. Alerting on failed runs waits for SENTRA-23. Running two worker processes against a very large first import has only been tested with threads.
