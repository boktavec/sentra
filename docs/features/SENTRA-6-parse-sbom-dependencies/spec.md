# SENTRA-6: Parse SBOM dependencies into a normalized model

- Status: Draft
- YouTrack: http://localhost:8080/issue/SENTRA-6 (Project & Asset Management, P1, size M)
- Owner: Brian (author), pipeline service

## Problem and outcome

- A project member's uploaded SBOM is only validated today (SENTRA-5). Nothing can be correlated with vulnerability data until its components are extracted into a normalized, matchable form.
- **Done means:** an uploaded CycloneDX JSON moves to `parsed` and its components are stored as deduplicated, purl-identified dependency rows tied to the source import. A bad file ends `rejected` with a reason; the raw object is always kept. An operator can re-run parsing from the stored object without a re-upload. Retries and redelivery never duplicate rows.

## Scope

- In scope:
  - Parse inside the existing `sbom.uploaded` consumer (validate, then parse, one pass).
  - Migration `008`: `sbom_dependencies`, new `parsed` status, new reason codes, import counters, pipeline-role grants.
  - `dependencyCount` and `skippedCount` on the existing import `GET` responses, shown as text in the project page imports list.
  - Operator Task command to reprocess an existing import.
  - Metrics, logs, fixtures, tests, learning note.
- Out of scope:
  - SPDX or other formats (own story, see SENTRA-5).
  - Dependency graph and `bom-ref` retention.
  - Any dependency list endpoint or UI (SENTRA-13, 15, 16 decide how it is read).
  - Member-triggered reprocess endpoint.
  - Matching against vulnerabilities (SENTRA-13), "current SBOM per project" semantics.
- Dependencies and related stories: depends on SENTRA-5 (done). Feeds SENTRA-13. SENTRA-21 should add `sbom_dependencies` to the cross-tenant suite.

## Decisions and alternatives

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Formats | CycloneDX JSON 1.4 to 1.7 only | SPDX; both | Inherited from SENTRA-5. |
| Trigger | Same consumer, same `sbom.uploaded` event; `uploaded` to `parsed` or `rejected` | Second stage via `sbom.validated`; separate `parse_status` column | No new topic, outbox, or second status to interpret. Cost: validation and parsing share a failure domain and handler time. |
| Identity | Valid purl required; canonical purl plus parsed `type`, `namespace`, `name`, `version`, and OSV ecosystem. No-purl components counted as `skipped_no_purl`, not stored | Fallback group/name/version row; store raw, normalize later | Deterministic matching, no fuzzy rows. Cost: SBOMs without purls lose components, surfaced via `skippedCount`. |
| Duplicates | One row per `(import_id, canonical_purl)` with `occurrences`; scope takes most-required (`required` over `optional`) | Keep `bom_refs[]`; one row per occurrence | Natural unique key gives idempotent insert and one match per package. Cost: graph position and `bom-ref` lost (known limitation). |
| Size and writes | Cap 50,000 components (configurable), batched inserts (about 1,000) in one transaction; over cap is `rejected(too_many_components)` | No cap; per-batch commits with progress marker | Atomic: failure leaves zero rows. Cost: one long transaction in a rare background job. |
| Exposure | Counts on existing `GET`s only | List endpoint; endpoint plus UI | Smallest isolation surface for an M story. Cost: parsed output not user-visible until later stories. |
| Reprocess | Operator Task command `task sbom:reprocess IMPORT_ID=...` | Member endpoint; both | No new authorization surface; needed for replay after a parser fix. Cost: users re-upload to retry. |
| Reprocess mechanism | Script (API/owner role) sets the import back to `uploaded` and inserts a new `sbom_outbox` row; the existing relay publishes; the consumer replaces that import's rows atomically (delete then insert in one transaction) | New event type; consumer accepts any status | Reuses the existing `WHERE status = 'uploaded'` guard, outbox, and relay unchanged. |
| purl parsing | `packageurl-python` | Hand-rolled parser | purl canonicalization has many encoding edge cases; the library is the reference implementation. **Assumed**, confirm maintenance and version when implementing. New dependency, so it needs justification in the PR. |

## Architecture and contracts

- Affected components: `services/pipeline` (`validate.py`, `process.py`, `imports.py`, new `parse.py` and dependency writer), `apps/api` (migration, import serializer, reprocess script), `apps/web` (counts text), `packages/contracts` (no event change).
- Flow: `sbom.uploaded` consumed; load import row (authoritative); read object by the row's key; validate; parse `components[]` (including nested components); canonicalize and dedupe; one transaction: delete existing rows for the import, insert in batches, set `parsed` with counts, guarded by `WHERE status = 'uploaded'`. Zero rows updated means duplicate delivery, roll back.
- Storage: `sbom_dependencies(id, import_id references sbom_imports, org_id, project_id, purl text, purl_type, namespace, name, version, ecosystem, scope, occurrences int, created_at)` with `UNIQUE (import_id, purl)` and an index on `(ecosystem, name)` for SENTRA-13. `sbom_imports` gains `dependency_count`, `skipped_count`. Status check adds `parsed`; reason codes add `too_many_components`, `no_components`. Existing `validated` rows remain valid and can be reprocessed.
- Pipeline role: `INSERT, SELECT, DELETE` on `sbom_dependencies` only; `UPDATE` column list on `sbom_imports` extended with the counters.
- Compatibility: additive migration; `GET` gains two fields.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | One parse per upload; rare | Follows SENTRA-5 | SENTRA-26/27 |
| Concurrent users or jobs | Bounded by consumer concurrency | **Unknown** | Measure |
| Data size and growth | Up to 50,000 rows per import, kept indefinitely | **Assumed** cap | Parse a large real container SBOM before merge; adjust cap |
| Latency or throughput target | **Unknown**; no target invented | n/a | Record parse seconds for the large fixture |
| Availability and recovery target | Replayable from the stored object | Story requirement | Reprocess test |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Valid SBOM with purls | `parsed`, rows and counts recorded | Integration test, real CycloneDX fixture |
| Zero components, or none with a purl | `rejected(no_components)` | Unit and integration |
| Component with malformed purl | Counted in `skippedCount`; others still stored | Unit |
| Same purl twice (also nested) | One row, `occurrences` summed, scope most-required | Unit; deterministic across runs |
| Over 50,000 components | `rejected(too_many_components)`, no rows written | Integration with generated file |
| Redelivered event | Guard hits zero rows, transaction rolled back, no duplicates | Worker test, sequential and parallel |
| Crash or database error mid-write | Transaction rolls back; retry per ADR 0002; exhausted retries give `rejected(processing_failed)` and the object is kept | Fault-injection test |
| Reprocess | Rows replaced atomically; counts updated; no re-upload | Integration test |
| Storage unavailable | Existing retry and backoff | Existing worker tests |
| Cross-tenant | Rows carry `org_id` and `project_id` from the import row, never from the event or file | Test with two orgs |

## Security, observability, and rollout

- Authorization and isolation: no new user-facing read or write path. Counts ride on the existing org-scoped project endpoints. The pipeline derives tenant IDs from the import row. SBOM content (names, versions) is tenant-confidential: not logged, not in events, audit rows, or error bodies. Parsing is in-memory over a capped file; nesting depth and component count are bounded.
- Metrics and logs: counters by outcome (`parsed`, `rejected` by reason, `skipped_duplicate`), parse duration histogram, dependencies-per-import histogram. Logs carry `importId`, `correlationId`, counts, outcome only.
- Rollout: migration then pipeline deploy. Rollback: stop consumer; existing `validated` imports are untouched. Backfill: run the reprocess command on existing `validated` imports. Owner: author.

## Acceptance criteria

- [ ] A valid supported SBOM is parsed into normalized dependency records.
- [ ] Each dependency stores canonical purl, type, namespace, name, version, and OSV ecosystem.
- [ ] Duplicates within one import collapse deterministically to one row with `occurrences`.
- [ ] Redelivered events create no duplicate rows (idempotent).
- [ ] Parse failures keep the upload and show `rejected` with a reason.
- [ ] Every dependency row references its source import, org, and project.
- [ ] The operator reprocess command rebuilds an import's dependencies from the stored object with no re-upload.
- [ ] Import `GET`s and the project page show dependency and skipped counts.

## Verification

- Manual: upload a real Syft or cdxgen SBOM in the web app, see `parsed` with counts; run `task sbom:reprocess`, see counts unchanged and no duplicate rows; upload a file with no purls, see the rejection reason.
- Automated: parser unit tests (purl canonicalization, dedupe, scope, nesting, skips); pipeline integration tests against real Postgres and SeaweedFS (parse, redelivery, mid-write failure, reprocess, cap); API test for counts and tenant scoping; Playwright for the UI counts.
- Load: parse the largest real SBOM available and record time and memory.

## Open questions and assumptions to validate

- 50,000-component cap and 1,000-row batch size are **assumed**; validate with a large container SBOM before merge.
- `packageurl-python` fit and purl-type to OSV-ecosystem mapping table (which types are supported at MVP): confirm during implementation, record any unmapped types as `ecosystem = null` (stored, unmatchable until mapped).
- Whether `validated` should be backfilled to `parsed` by reprocessing in each environment.
