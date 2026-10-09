# SENTRA-8: Ingest CISA KEV data

- Status: Implemented, in review
- YouTrack: http://localhost:8080/issue/SENTRA-8 ("[MVP] Ingest CISA KEV Data")
- Owner: Sentra operator / project owner

## Problem and outcome

- A Sentra operator needs to know which vulnerabilities are actively exploited, because severity alone does not say what attackers use. SENTRA-14 (risk score) and SENTRA-16 (UI) need this signal; today Sentra has none.
- Done means: publishing a signed `crawl.requested` for `source=cisa-kev` fetches the current catalog, stores it untouched, normalizes it into a KEV enrichment table plus `vulnerabilities` rows, and makes "is this CVE in KEV?" answerable in SQL. Re-running changes nothing. Failures are visible in logs, metrics, run state and `crawl.failed`.

## Scope

- In scope:
  - Crawler support for a second source (`cisa-kev`), via a source registry replacing the hardcoded OSV/zip assumptions.
  - Normalizer KEV adapter, a non-zip (single JSON) reader, `kev_entries` table, tombstoning, shrink guard.
  - Linked `vulnerabilities` rows (source `cisa-kev`), joined to other sources through CVE aliases.
  - SQL view resolving a vulnerability to KEV status.
  - Task wrapper to publish the signed request manually.
  - ADR for the model decision, learning note.
- Out of scope (documented, not built):
  - Scheduling (SENTRA-10), cross-source dedup (SENTRA-12), risk scoring (SENTRA-14), KEV in API/UI (SENTRA-14, SENTRA-16).
  - Waking the correlator on KEV changes (nothing consumes KEV yet).
  - EPSS or other enrichment feeds.
- Dependencies and related stories: builds on SENTRA-7 (crawler), SENTRA-11 (normalizer), SENTRA-30 (crawler hardening). Unblocks SENTRA-14, SENTRA-16.

## Decisions and alternatives

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Data model | Both: `kev_entries` enrichment table (source of truth for KEV status) plus a `vulnerabilities` row per KEV CVE (source `cisa-kev`) | Enrichment only; canonical rows only (as documented in `models.md`) | Enrichment keeps KEV facts that `vulnerabilities` has no column for. Stub rows keep KEV visible wherever vulnerabilities are listed. Cost: two writes per entry and an ADR, since this departs from `models.md`. |
| Stub rows | Always create, linked by CVE alias; duplicates with OSV tolerated until SENTRA-12 | Create only if no alias match | Order-independent and idempotent. The stub row carries no `affected` entries (KEV names a vendor and product, not a package), so it never matches a dependency. The same CVE can look duplicated across sources for now. |
| Removals | Tombstone: `removed_at` set when a CVE leaves the catalog, cleared if it returns | Mirror latest snapshot; never remove | Keeps history for audit. Every reader must honor `removed_at`; the view does so. |
| Data flow | Generalize crawler -> `artifact.ingested` -> normalizer | Standalone KEV job | Reuses signing, leases, retries, etag/sha256 idempotency and run tables. Touches shared OSV code, so OSV regression tests are required. |
| Lookup | SQL view only | API route; `kev` flag on findings | Keeps this story in Data scope; avoids API contract before SENTRA-14/16 shape it. |
| Trigger and freshness | Manual signed request now; daily later | In-story timer; stated minutes SLA | SENTRA-10 owns the schedule. Daily is Assumed enough, since the catalog changes a few times a week; validate against `dateReleased` gaps. |
| Bad-snapshot guard | Schema check, `count` equals record count, and a shrink limit before tombstoning | Schema only; reuse the 1% quarantine rule | Protects against a truncated or empty catalog marking everything removed. A legitimate large removal needs a manual override. |
| Entry update guard | Content hash per entry | Timestamp | KEV has no per-record modified time. |
| Ecosystem field | Sentinel `none` (Assumed, confirm in the contract change) | Make `ecosystem` optional | Contracts require a non-empty `ecosystem`. A sentinel is additive; optional would be a v2 contract. |

Third-party facts, checked 2026-10-08 against the live feed `https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`:

- **Verified (curl and the crawler's own `fetch`):** `200`, `content-type: application/json`, `etag`, `last-modified`. CISA **ignores `If-None-Match`** (returns `200` with the matching ETag) but honors `If-Modified-Since` (`304`). The crawler only sends `If-None-Match`, so each run downloads the 1.7 MiB body and the `sha256` comparison with the previous run makes it `unchanged`. Sending `If-Modified-Since` would need a `last_modified` column on `ingestion_runs`; not worth it at this size.
- **Verified:** body is one JSON object with `title`, `catalogVersion` ("2026.10.08"), `dateReleased` (ISO timestamp), `count` (1739) and `vulnerabilities`. The body is 1,777,558 bytes (about 1.7 MiB) and `count` equals the array length.
- **Verified:** per-entry fields are `cveID`, `vendorProject`, `product`, `vulnerabilityName`, `dateAdded`, `shortDescription`, `requiredAction`, `dueDate`, `knownRansomwareCampaignUse`, `notes`, plus `cwes` and `forensicTriage`, which `models.md` does not mention. Some strings have leading whitespace (e.g. `vulnerabilityName`), so normalize by trimming.
- **Assumed:** the feed URL and schema stay stable, and not every field is present on every entry (the field set above is a union over all entries). Validate with a schema test using a real catalog fixture, and treat unknown fields as additive.
- **Assumed:** removals are rare. Validate by comparing archived snapshots before fixing the shrink threshold.

## Architecture and contracts

- Affected components: `services/crawler`, `services/pipeline` (normalize), `packages/contracts`, `apps/api/migrations`, `infra/docker` (Task wrapper).
- Flow: operator publishes signed `crawl.requested {source: cisa-kev, ecosystem: none}` -> crawler does a conditional GET and stores the JSON content-addressed at `raw/cisa-kev/none/<sha256>.json` with its sidecar -> `artifact.ingested` -> normalizer adapter validates the snapshot, upserts `kev_entries` and `vulnerabilities`, tombstones missing CVEs, and records a `normalization_runs` row.
- Storage (migration `011_kev.sql`):
  - `kev_entries`: `cve_id` PK, `vendor_project`, `product`, `name`, `description`, `required_action`, `date_added`, `due_date`, `known_ransomware_use`, `cwes text[]`, `notes`, `content_hash`, `removed_at`, `catalog_version`, `date_released`, `source_artifact_sha256`, `adapter_version`, timestamps. Global table, no `tenant_id`.
  - View `vulnerability_kev_status`: for each `vulnerabilities` row, `in_kev` true when its `source_id` or any alias matches a `kev_entries.cve_id` with `removed_at IS NULL`.
  - Grants for the normalizer role; a test pins them.
- Contracts: **no schema change was needed.** `source` is a free pattern and `ecosystem` accepts `none`. The artifact key is `raw/cisa-kev/none/<sha256>.json` with a `<sha256>.meta.json` sidecar (a `.json` sidecar would overwrite the artifact). No `vulnerability.v2` is needed, since the flag lives in `kev_entries`.
- Compatibility: OSV behavior unchanged; guarded by regression tests.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | One request per trigger, manual now, about daily later | Assumed | SENTRA-10 |
| Concurrent users or jobs | 1 run at a time (lease) | Existing lease | Integration test |
| Data size and growth | About 1.7 MiB, 1,739 entries, growing slowly | Verified 2026-10-08 | Re-measure on each fetch (metric) |
| Latency or throughput target | **Unknown**. Propose reporting the end-to-end duration and set a target after measuring | No invented number | Measure in integration test and the manual run |
| Availability and recovery target | Not user-facing. Recovery by re-running the request or replaying the raw artifact | Existing pipeline design | Replay test |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Empty, truncated, or malformed JSON; wrong `count` | Run fails; no rows change; `crawl.failed`/failed run recorded | Integration test with bad fixtures |
| Snapshot would tombstone more than the limit | Run fails with a clear reason; manual override only | Integration test |
| Duplicate request or unchanged catalog (304 or same sha256) | Run `unchanged`; no writes, no duplicate event | Run twice, compare rows and `updated_at` |
| Upstream 5xx, timeout, truncation | Bounded retry with backoff (existing crawler) | Fake KEV server scripted failures |
| CVE removed then re-added | `removed_at` set then cleared; history in sidecar/raw | Integration test |
| CVE also present from OSV | Both rows exist; view reports `in_kev` for both via alias | Integration test |
| Entry with leading/trailing whitespace or a missing optional field | Trimmed or null; entry kept | Unit test on a real fixture |
| Concurrent normalization | Run row unique on `(artifact_sha256, adapter_version)` | Existing mechanism, test with KEV |
| Tenant boundary | Global data, no tenant data read or written | Grants test |

## Security, observability, and rollout

- Authorization and security: requests are HMAC-signed; fixed HTTPS allowlist for the feed host; size cap and content check become source-specific (JSON, not zip magic). Raw payload is never logged. Normalizer role gets only the grants it needs.
- Observability: reuse crawler and normalizer metrics with `source="cisa-kev"`. Add counts for entries added, updated, tombstoned and the shrink-guard failure. Run state in `ingestion_runs` and `normalization_runs`; failures in `crawl.failed`. Alerts belong to SENTRA-23.
- Rollout: migration runs on API start; no feature flag. Rollback by reverting code; the added table is harmless to leave. Owner: project owner.

## Acceptance criteria

- [ ] Sentra can retrieve the current CISA KEV catalog (verified against the live feed).
- [ ] Raw snapshot is stored unmodified with its provenance sidecar.
- [ ] Entries are normalized into `kev_entries` and linked `vulnerabilities` rows.
- [ ] Re-running ingestion is idempotent (no changed rows, no duplicate events).
- [ ] The view reports a vulnerability as in or not in KEV, and honors tombstones.
- [ ] Source timestamps (`catalogVersion`, `dateReleased`, `dateAdded`) and provenance are preserved.
- [ ] Failures and retries are observable (logs, metrics, run state, `crawl.failed`).
- [ ] A truncated or shrunken snapshot fails without changing data.
- [ ] OSV ingestion still passes its existing tests.

## Verification

- Manual: `task stack:up`; publish the signed request; check the object in `sentra-raw`, `ingestion_runs` and `normalization_runs`; query the view for a known KEV CVE and for a non-KEV CVE; re-run and confirm `unchanged`.
- Automated: fake KEV server with a real catalog slice; unit tests for the adapter and guard; integration tests for idempotency, tombstone/return, bad snapshots, grants; OSV regression.
- Failure: scripted 5xx/truncation on the fake server; crash between store and publish.

## Open questions and assumptions to validate

- Shrink threshold value (proposed 10%). Owner: user, with archived snapshot comparison, before the normalizer PR.
- Ecosystem sentinel `none` and the 10% shrink threshold (floor of 5 removals) were taken as the recommended defaults; change them in review if wrong.
- Does a KEV-only change need to wake the correlator? Currently no consumer; revisit in SENTRA-14.
- Split into stacked PRs (crawler generalization, then normalizer and model)? Recommended.
