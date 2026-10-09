# SENTRA-9: Ingest GitHub Security Advisory data

- Status: Implemented (pending independent review); live authenticated run not yet done
- YouTrack: http://localhost:8080/issue/SENTRA-9
- Owner: Sentra operator / data engineering

## Problem and outcome

- Sentra operators need GitHub Security Advisory (GHSA) coverage so dependency findings include ecosystem advisories that OSV and KEV alone may miss or describe differently.
- Done when an operator can request a GHSA crawl, the raw API responses are preserved, advisories are normalized by a GHSA adapter into the common vulnerability model with provenance, and overlap with OSV/KEV resolves deterministically through existing grouping.
- It is also the third source, proving the crawler and pipeline take a new provider through an adapter plus registry entries, not provider logic spread through the app.

## Scope

- In scope:
  - Paginated retrieval from the GitHub REST global advisories API, `type=reviewed` only.
  - Full first run, then incremental runs by `modified` watermark.
  - Token credential via secure config; rate-limit pacing and a distinct `rate_limited` outcome.
  - One raw bundle per run, one `artifact.ingested` event.
  - GHSA normalizer adapter, `withdrawn_at` mapping, provenance.
  - Metrics, logs, and tests, including an overlap and order-independence test with OSV fixtures.
- Out of scope:
  - Malware and unreviewed advisories.
  - GraphQL API; repo-archive ingestion.
  - Scheduling or periodic triggers (manual signed `crawl.requested` only).
  - Changes to the SENTRA-12 grouper; gaps found are recorded as follow-ups.
  - Alerting rules (SENTRA-23).
- Dependencies and related stories: SENTRA-7 (OSV), SENTRA-8 (KEV), SENTRA-11 (normalizer), SENTRA-12 (grouping, ADR 0005), SENTRA-30 (crawler hardening), ADR 0002 (event conventions).

## Decisions and alternatives

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Source API | REST `GET /advisories` | GraphQL `securityAdvisories`; `github/advisory-database` archive (OSV-format) | REST exercises token, pagination and rate-limit ACs with a real provider adapter. GraphQL adds points-based limits for no gain. The archive would mostly reuse the OSV adapter and skip the very behavior this story validates. Cost: crawler must grow pagination, token and rate-limit handling. |
| Advisory scope | `type=reviewed` | + malware; all types | Reviewed carries package and range data and limits overlap. Malware has a different shape (no CVE) the model may not handle. Unreviewed duplicates NVD. Gap: no malware coverage in MVP. |
| Sync strategy | Full first run, then `modified >= watermark - overlap` | Full snapshot every run; incremental-only with manual backfill | Saves rate limit on unchanged data. Cost: persisted watermark, advanced only after a fully successful run, plus an overlap window to absorb page drift. |
| Raw artifact | One bundle per run (unmodified page bodies), single event | One artifact per page; size-capped bundles | Fits existing storage, event and `(artifact_sha256, adapter_version)` dedupe contracts. Cost: a failed run stores nothing; first-run bundle is large (measure; see Workload). |
| Rate limits | Pace from `x-ratelimit-*` and `Retry-After`; sleep if wait fits the run timeout, else fail `rate_limited` (retryable, watermark unchanged) | Fail fast; reuse generic backoff | Honors limits as the AC requires. Cost: sleeping affects lease length; claim lease already derives from total timeout. |
| Credentials | `CRAWLER_GITHUB_TOKEN` env, redacting secret type, host-pinned to `api.github.com` over HTTPS, required for GHSA runs | Optional token; GitHub App | Unauthenticated (60 req/hr) cannot finish a backfill. App tokens are overkill for public data. Cost: manual rotation. |
| Overlap | Own `vulnerabilities` rows per `(source='ghsa', source_id)`, newer `updated_at` wins; cross-source merge via existing grouper | Extend grouper here | Keeps scope in this story; proves behavior with tests. Gaps become follow-ups. |
| Withdrawn | Ingest and keep, map `withdrawn_at`; downstream excludes | Skip at adapter | Skipping would leave stale active rows when an advisory is later withdrawn. |
| Bundle format | A deterministic zip with one entry per API page, bodies unmodified (fixed entry timestamps, so identical content hashes identically) | NDJSON of pages; one entry per advisory | Reuses the existing `.zip` key layout, the `PK` magic check, `archive.entries` zip-bomb limits, and the sha comparison for "unchanged". The adapter expands pages (`page-00001.json[17]` is the provenance entry). Cost: a bundle is built in a temp file before upload (no streaming upload). |
| Watermark storage | Nullable `ingestion_runs.watermark` (migration 015), written by `mark_stored`/`mark_unchanged`; the baseline is the newest `published` or `unchanged` run (`latest_published`) | Separate watermark table; advance inside `mark_published` | A stored-but-unpublished or failed run is invisible to the baseline by construction, so no extra transaction is needed and the "advance only after published" rule holds. Cost: the watermark is the newest advisory `updated_at` seen (upstream clock, not ours). |
| Incremental "unchanged" | Nothing newer than the watermark in the response (only overlap rows) ends the run `unchanged`; otherwise the bundle includes the overlap rows | Always store the overlap rows; hash-compare only | Avoids a tiny artifact every run. Accepted edge: an advisory updated in the same second as the watermark but after the previous fetch is missed until any newer advisory triggers a bundle (the overlap window then re-fetches it). |
| Rate-limit outcome | `crawl.failed` is still published (reason `rate limited for Ns...`), the run is `failed`, and `handle` returns `rate_limited` for `crawler_requests_total` | New event type or run status | No contract change (ADR 0002 unchanged). A retry is a new `crawl.requested`. |

## Architecture and contracts

- Affected components and ownership:
  - Crawler (`services/crawler/src/crawler/`): `ingest.py`, `fetch.py`, `config.py`, `runs.py`, `metrics.py`.
  - Pipeline normalizer (`services/pipeline/src/pipeline/normalize/`): new `adapters/ghsa.py`, registered in `process.py`.
  - API migrations (`apps/api/migrations/`): `015_ingestion_watermark.sql` adds `ingestion_runs.watermark`.
  - Contracts: `packages/contracts/models.md` (GHSA mapping now built). `vulnerability.v1.json` already has `withdrawnAt`, so no schema change.
- Request, event, and data flow: signed `crawl.requested` (`ghsa`, `none`) -> crawler claims lease, reads the stored watermark, pages `/advisories` -> stores bundle at `raw/ghsa/none/<sha256>.<ext>` plus meta sidecar -> `artifact.ingested` -> normalizer (`ADAPTERS['ghsa']`) -> `vulnerabilities.normalized` -> correlator/grouper (unchanged). The watermark advances only after the artifact is stored and the event published.
- API, event, and storage contracts: no new event types. Meta sidecar carries bundle format and the request window (`modifiedFrom`), never credentials. Bundle format: a zip of raw page bodies (see Decisions). The sidecar adds `bundleFormat` (`github-advisory-pages-zip`) and `modifiedFrom` (the lower bound requested, null on a full run). An ADR is added only if it proves long-lived.
- Compatibility and migration: additive only. Existing sources are unaffected. A GHSA run without a token fails with a clear error.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | First run a few hundred requests (page size 100); incremental runs a handful | **Assumed**: ~25k reviewed advisories (not counted: the live API reports no total). **Verified** 2026-10-09: 100 advisories per page, about 730 KB per page (largest advisory 25 KB), so a full run is on the order of 250+ requests | Live authenticated full run; record page count |
| Concurrent users or jobs | One GHSA run at a time (lease) | `Runs.claim` lease is per `runId`, not per source: a redelivered request does not double-fetch, but two different ghsa requests can run concurrently (cost: doubled rate-limit use; correctness holds because the watermark comes from the latest published run and upserts are idempotent). Follow-up: per-source mutual exclusion | Integration test: duplicate request does not double-fetch |
| Data size and growth | First-run bundle tens of MB | **Assumed** (raw is roughly 180 MB for 25k advisories at the measured 7.3 KB average; the compressed bundle is not measured) | Decided: temp-file staging, pages held in memory one at a time (cap 32 MiB per page, `max_bytes` per run). Measure on the first authenticated run |
| Latency or throughput target | **Unknown**, record measured first-run duration | No target invented | Measure in manual test |
| Availability and recovery target | Failed run leaves no artifact and does not advance watermark, so a retry is safe | Design property | Failure-injection test |
| Rate limit | 5,000 req/hr authenticated | **Verified** unauthenticated: `x-ratelimit-limit: 60`, `x-ratelimit-resource: core`. **Assumed** 5,000/hr authenticated (GitHub docs say so for a personal token) | Read `x-ratelimit-limit` on the first authenticated run |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Rate limit hit mid-run | Sleep if reset/`Retry-After` fits the timeout, else fail `rate_limited`; no artifact; watermark unchanged. Also paces proactively when `x-ratelimit-remaining` is 0 and another page follows | Unit tests with the fake upstream; integration test for the outcome |
| 5xx or timeout | Existing backoff (5 attempts); then `crawl.failed` | Unit test |
| Duplicate `crawl.requested` | Lease and `runId` prevent double work | Integration test |
| Incremental run with no changes | Ends `unchanged`; no artifact, no event | Integration test |
| Advisory updated while paginating | Overlap window plus upsert on newer `updated_at` makes it converge | Unit test on window math |
| Withdrawn advisory | Stored with `withdrawn_at`; excluded downstream | Adapter + downstream test |
| Missing or invalid token | GHSA run fails fast with a clear error; no request sent | Unit test |
| Token leakage | Token absent from logs, events, sidecar and error messages | Test asserts redaction |
| Malformed or partial page | Run fails; nothing stored; normalizer-side bad entry goes to `normalization_failures` | Unit test |
| Replay of stored bundle | Normalizer reprocesses deterministically; `(artifact_sha256, adapter_version)` dedupes | Integration test |
| Same advisory from OSV and GHSA | Separate rows, grouped by aliases; result independent of ingest order | Order-independence test |
| Tenant boundary | N/A: source data is global, not tenant data | n/a |

## Security, observability, and rollout

- Authorization, tenant isolation, sensitive data, abuse limits:
  - Token is the only secret. It is host-pinned, HTTPS-only, never logged, and `authorization` stays on the logging deny list (`packages/contracts/logging.md`).
  - Source URL comes from config, never from events.
  - Requests are bounded by the rate-limit pacing and the run timeout.
- Logs, metrics, traces, and alerts:
  - JSON logs with `runId` and `correlationId`, per `logging.md`.
  - Metrics: pages fetched, rate-limit remaining gauge, rate-limit wait seconds, `rate_limited` outcome in `crawler_requests_total`, bytes downloaded.
  - Alert rules belong to SENTRA-23.
- Rollout, migration, rollback:
  - Additive migration; rollback means not issuing GHSA requests.
  - Apply migration 015 before deploying the new crawler, for every source: `Runs._COLUMNS` selects `watermark` for all runs.
  - No scheduler, so enabling is a manual `task crawler:request -- ghsa none`.
  - Operational owner is the platform operator.

## Acceptance criteria

- [ ] A signed crawl request for `ghsa` retrieves reviewed advisories via the REST API, paginated, and the first run completes against a fake upstream (done) and once against the live API (not done: needs a token).
- [x] The token is supplied only through `CRAWLER_GITHUB_TOKEN`, is redacted everywhere, and a missing token fails the run before any request.
- [x] Rate-limit headers are honored: sleep within the cap, else a distinct `rate_limited` failure with the watermark unchanged.
- [x] Raw page bodies are preserved unmodified in one bundle per run with sha256 and meta sidecar.
- [x] The GHSA adapter maps advisories (IDs, aliases, severity/CVSS, packages and ranges, `withdrawn_at`) into the common model.
- [x] Incremental runs fetch only changes since the last successful watermark (with overlap) and converge on duplicates.
- [x] Overlapping OSV/GHSA advisories group identically regardless of ingest order.
- [x] Provenance (source, source URL, artifact sha256, entry, adapter version) is queryable after normalization.
- [x] Rate-limit and error conditions are visible in metrics and logs.

## Verification

- Manual checks and expected results:
  - `task stack:up`, then `task crawler:request -- ghsa none` with a real token: raw object appears in `sentra-raw`, `vulnerabilities` rows with `source='ghsa'` appear, and a second request fetches only changes.
  - Record real response headers, page shape and limits here, labelled **Verified**.
  - **Verified (live, unauthenticated, 2026-10-09):** `GET /advisories?type=reviewed&per_page=100&sort=updated&direction=asc&modified=>=<ts>` returns 200 with a JSON array, ascending by `updated_at`; `modified` filters on updated-or-published time; the `Link: <...&after=<cursor>>; rel="next"` header pages forward without overlap and is absent on the last page; an empty window returns `[]`; withdrawn advisories (`withdrawn_at` set, `cve_id` possibly null) appear in `type=reviewed`; `cvss_severities.cvss_v3/cvss_v4.vector_string` can be null, and the older top-level `cvss` repeats the v3 vector; ranges seen: `>= a, <= b`, `< b`, `>= a, < b`, `<= b`, `= v` (no `>` in 236 advisories). The adapter normalized and validated all 236 sampled advisories with 0 failures.
  - **Not verified (needs a real token):** authenticated limits and headers, the first full run's page count, size and duration, and `rate_limited` behavior against the real API. These stay **Assumed**.
- Automated tests and what they prove:
  - Adapter unit tests on real-payload fixtures in `tests/fixtures/ghsa/`.
  - Fake-upstream tests for pagination, rate limit, 5xx and the token path.
  - A token-redaction test.
  - Integration tests for end-to-end ingest, incremental runs, and OSV/GHSA order independence.
- Commands: `task check`, `task crawler:test`, `task pipeline:test`, integration variants, `task fallow`.

## Open questions and assumptions to validate

- Resolved by inspection against the live API: `modified` semantics (updated or published, `>=` works, ascending by `updated_at` with `sort=updated&direction=asc`), cursor pagination via the `Link` header.
- **Assumed:** a 1-hour overlap (`ghsa.OVERLAP`) is a safe window for pages that drift while paginating. With ascending `updated` order, an advisory edited mid-run moves to the end and is still reached, so the overlap is a second line of defense, not measured.
- **Assumed:** the first authenticated run fits `Limits.total_timeout` (15 min). If measured duration disagrees, raise the timeout (the claim lease follows it) rather than special-casing GHSA.
- Resolved: the canonical model already has `withdrawnAt` (`vulnerabilities.withdrawn_at`), and the correlator ignores withdrawn rows (`reconcile.py`: `v.withdrawn_at IS NULL`; open findings resolve as `advisory_withdrawn`), so no contract change was needed. Findings list/detail paths (SENTRA-14/15/16) read through findings, which reconcile already resolves; a direct read of `vulnerabilities` that ignores `withdrawn_at` was not audited beyond that.
- Resolved: bundle format and staging (see Decisions). Stacked PRs: not split; the crawler and adapter parts are independent enough to split at `ghsa.py` / `adapters/ghsa.py` if the reviewer prefers.

## Known gaps and follow-ups

- `>` (exclusive lower bound) ranges are quarantined, not approximated; none appeared in the 236 sampled advisories. If they show up in `normalization_failures`, extend the model, not the adapter.
- Only `npm` and `PyPI` ranges are verified by the matcher; other GHSA ecosystems match as `ecosystem_unsupported` (a matcher/comparator follow-up, shared with OSV).
- `crawler_download_bytes_total{source="ghsa"}` counts compressed bundle bytes, not raw page bytes.
- If normalization of a stored bundle fails permanently, the crawler watermark has already advanced; recovery is `pipeline.normalize.reprocess --source ghsa none` on the preserved artifact.
- No scheduler (SENTRA-10) and no alert rules (SENTRA-23).
- Pre-existing breakage fixed in passing: the pipeline integration `env` fixture truncated `findings` without `CASCADE` and failed since the investigations table (migration 014) references it; one existing test used `ghsa` as its example of an unsupported source and now uses `unknown-source`.
