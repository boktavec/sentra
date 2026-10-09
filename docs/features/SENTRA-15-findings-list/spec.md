# SENTRA-15: Findings list

- Status: Implemented on feature branch; PR review pending
- YouTrack: http://localhost:8080/issue/SENTRA-15 ("[MVP] Findings List")
- Owner: Sentra project owner; API and web implementation, pipeline normalization for CVSS
- Architecture decision: [ADR 0006](../../adr/0006-cvss-severity-for-grouped-findings.md)

## Problem and outcome

Project members can upload an SBOM and Sentra can derive findings, but the application has no findings page. A member needs a bounded, understandable view of current exposure without having to call the API. Done means an authorized member can open a dedicated project Findings page, see and filter its findings, understand uncertainty and unavailable enrichment, and page through a project with up to 25,000 findings. The list must meet the agreed first-page API performance target and preserve tenant isolation.

## Scope

- In scope:
  - Dedicated Findings page linked from the project page; open findings by default, with resolved findings accessible through a status filter.
  - Vulnerability identifier and sources, affected dependency and version, CVSS score/category/version when calculable, explicit unavailable severity otherwise, match quality, status, and KEV context. Without a completed KEV snapshot and reliable linkage, say exploitation data is unavailable, never "not exploited."
  - Status and severity-category filters; severity-first default sort; cursor pagination; empty, loading, error, and manual Refresh states.
  - Standard CVSS base-score calculation from stored v4 or v3 vectors on the shared vulnerability record, including an idempotent backfill of existing records. Highest supported valid version wins (v4 before v3); the selected version is shown.
  - API query and response extensions, tenant/project isolation checks, CVSS tests, API integration tests, web UI tests and Playwright screenshots, benchmark, docs and learning note.
- Out of scope:
  - Sentra risk priority, KEV ingestion/weighting, exposure signals (SENTRA-14); finding detail (SENTRA-16); user triage/editing; automatic polling or push updates; dependency search; match-quality filter.
  - New availability SLOs or production capacity claims (SENTRA-26).
- Dependencies and related stories: SENTRA-13, SENTRA-8 and SENTRA-12 are Done. SENTRA-12 changed the read model to one item per dependency and vulnerability group; SENTRA-8 provides `kev_entries` and a KEV lookup view. SENTRA-14 is Ready, so Sentra risk priority remains outside this story. SENTRA-21 already covers the findings list route in its tenant isolation suite; its remaining `findings` todo is for SENTRA-16's detail route. The acceptance criterion in the current YouTrack description is stale on that point, as is SENTRA-21's findings checkbox.

## Decisions and alternatives

Claims about third-party behavior are labeled **Verified** or **Assumed** with a validation path.

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Delivery boundary | List on current finding data; CVSS base severity in this story; risk priority later, KEV from merged SENTRA-8 | Wait for SENTRA-14; pull all scoring into SENTRA-15 | Delivers a truthful first list without expanding into prioritization. |
| Placement | Dedicated project Findings page linked from project page | Full list on project page; project preview plus full page | Room for filters and pagination; one extra navigation step. |
| Default status | Open; status filter can show resolved or all | Show all statuses by default | Focuses on current exposure while retaining history. `unverifiable` is a match quality, not a status. |
| Severity | Derive standard CVSS base score/category from stored vectors; show version; unknown remains unavailable | Raw vector only; wait for risk score | Makes severity sorting meaningful without conflating CVSS and Sentra risk. |
| Multiple vectors | Newest supported **valid** version: v4 then v3 | Highest score; v3 preference | Deterministic and transparent; scores from different versions still share one list, so show the version. |
| Score ownership | Store derived CVSS fields on `vulnerabilities` during normalization and backfill existing rows | Copy to each finding; score on each read | One shared score per advisory; list query joins and sorts up to the project limit. Benchmark before accepting. |
| Grouped severity | Highest valid advisory score in the SENTRA-12 group, with scoring source shown | Canonical advisory only | An unscored canonical advisory should not hide a scored source; score can change when group membership changes. |
| Default order | Score descending, unavailable last; then `first_seen_at` descending and finding ID for deterministic ties | Newest first; dependency order | Prioritizes available severity; deterministic keyset cursor supports paging. |
| Refresh | Re-fetch on navigation and manual Refresh | Polling; push | Avoids idle traffic and moving pages; data may be stale until refresh. |
| Filters | Status and severity category; match quality displayed per row | Quality filter; package search | Small first surface and bounded API query combinations. |
| KEV | Read the completed SENTRA-8 enrichment, with listed/not listed/unavailable states | Defer; infer from `cisa-kev` source alone | A stub advisory can remain after catalog removal, so the current `kev_entries` tombstone is authoritative. A completed snapshot is required before saying not listed. |

**Verified (repository, 2026-10-08):** `vulnerabilities.severity` stores `{type, vector}` entries with no calculated score. SENTRA-12's list query groups findings by `(purl, group_id)` and returns a canonical advisory plus `sources[]`; an advisory not yet grouped remains its own item. SENTRA-8's `kev_entries` records removals with `removed_at` and its `vulnerability_kev_status` view matches aliases, so source presence alone is not KEV status. The list route uses authenticated org scope and a project lookup, and `apps/api/src/tenant-isolation.integration.test.ts` already has cross-tenant list cases. The project page currently contains the SBOM upload section. See `apps/api/src/findings.ts`, migrations 011/012, `apps/api/src/findings-routes.ts`, and `apps/web/src/app/orgs/[slug]/projects/[projectSlug]/page.tsx`.

**Verified (Context7 documentation, 2026-10-08):** Red Hat Product Security's Python `cvss` documentation for version 3.6 says `CVSS3` and `CVSS4` parse v3.0/v3.1 and v4.0 vectors and expose `scores()` and `severities()`; invalid mandatory metrics raise errors. This is documentation, not verification of Sentra's runtime. Source: https://github.com/redhatproductsecurity/cvss/tree/master/_autodocs/api-reference .

**Verified (running pipeline, 2026-10-08):** pinned `cvss` 3.6 parsed v3.0, v3.1 and v4.0 reference vectors (9.8, 9.8 and 9.9), rejected a malformed v4 vector, and fell back to a valid v3 vector in unit tests. A real Postgres normalization/backfill integration test passed. The local database did not contain a representative production OSV vector corpus, so distribution and malformed/unsupported counts remain unmeasured; parse failures are logged with version only, without the raw vector.

## Architecture and contracts

- Components and ownership: `services/pipeline` calculates CVSS fields when normalizing an advisory and owns an idempotent operator backfill; `apps/api` migrates storage and extends the authorized read query; `apps/web` presents the list through the existing server-side authenticated API client. No new service or datastore.
- Flow: source advisory -> existing normalization -> selected valid CVSS vector -> score/version stored on `vulnerabilities`; existing correlator writes tenant-scoped findings independently; SENTRA-12 groups advisories for the read model; web sends user token to API -> API scopes org and project -> query groups findings, joins severity and active KEV enrichment -> filters, sorts and pages server-side -> web renders rows.
- API: extend `GET /v1/orgs/:orgId/projects/:slug/findings` with optional `status=open|resolved|all`, `severity=critical|high|medium|low|none|unavailable`, `sort=severity|newest`, `limit`, and an opaque cursor tied to the selected filters/sort. Default `status=open`, `sort=severity`, `limit=50`; cap at the existing route limit unless measurement warrants changing it. The response keeps SENTRA-12's grouped fields and `sources[]` and adds nullable CVSS fields (including the advisory that supplied the group score) plus `kevStatus=listed|not_listed|unavailable`. `not_listed` requires a completed catalog snapshot; `unavailable` covers no completed snapshot or unknown linkage. `none` is valid CVSS 0.0; `unavailable` means no usable vector. Invalid parameters return the existing problem shape. The cursor order is `(cvssScore DESC NULLS LAST, firstSeenAt DESC, findingId)` for severity sort; `newest` uses existing time/ID order. Changing filters or refreshing starts from page one.
- Storage: migration `013_cvss_scores.sql` adds nullable CVSS score and version columns on `vulnerabilities`; category may be derived from score using standard thresholds. Existing `severity` JSON remains source evidence. Normalization writes derived columns in the same advisory transaction. The backfill handles existing rows in bounded batches, is resumable/idempotent, and does not advance the matching watermark solely for display-field updates. The exact index or query shape is chosen from `EXPLAIN ANALYZE` and the 25,000-finding benchmark rather than assumed.
- Compatibility: existing API clients may omit all new query parameters and still receive a page; document the changed default ordering for clients that depended on newest-first. During backfill, not-yet-scored records sort after scored ones and show unavailable. Rollback stops new scoring code and leaves harmless nullable columns; the original raw vectors remain intact.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | **Unknown** | No production workload is established | Record first-party API request rate; SENTRA-26 sets broader targets. |
| Concurrent users | **Unknown** | No production workload is established | Benchmark modest concurrent reads and record the concurrency used. |
| Project data size | Up to 25,000 findings in one project | Owner-selected acceptance case; SENTRA-13 measured a dense project with 22,879 findings | Seed representative score/status distribution; query plan and UI pagination test. |
| First-page API latency | p95 < 1 second on the local stack at 25,000 findings | Owner-selected target, not a production SLO | Warmed run of at least 100 requests; record machine, dataset, concurrency, p50/p95/p99, errors, and query plan. |
| Availability and recovery | **Unknown** SLO; bounded API timeout and visible error state | Existing web API client has a 5-second timeout; no agreed uptime target | Stop API/DB, verify safe error and retry via Refresh; backfill resumes after interruption. |
| Growth | **Unknown** | Current lab target is 1,000 projects in SENTRA-13; per-project cardinality is the relevant list bound | Track rows per project and list latency; revisit indexes and limits from measured data. |

**Measured (2026-10-08):** `pnpm run bench:findings` creates a scratch Postgres database, seeds 25,000 findings in one project across five advisory score buckets (including unscored), five vulnerability groups, a completed KEV snapshot, and open/resolved statuses, then sends 10 warm-up and 100 timed authenticated Fastify first-page requests at concurrency 1. On the local arm64 macOS 26.6.2 stack, p50 was **73.0 ms**, p95 **74.7 ms**, p99 **77.1 ms**, with no errors. This meets the agreed 1-second local target. It measures synthetic data and a warm database; real group-size distributions and concurrent traffic remain unmeasured. The scratch database is dropped afterward. A separate query plan capture remains useful when a representative production distribution exists.

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| No SBOM or no findings | Clear empty state; this page does not distinguish no imports from no matches | Browser and API fixtures. |
| Missing, unsupported or malformed CVSS vector | Finding remains visible, severity unavailable, sorted last; record count without logging raw vectors | Real-vector sample and malformed fixtures. |
| Multiple vectors | Choose valid v4 over v3; fall back to valid v3 if v4 is malformed; show selected version | Scoring tests. |
| `unverifiable` match | Visible with explicit uncertainty badge, never labeled confirmed | UI and API fixtures. |
| Multiple advisories for one issue | One grouped list item with all source advisories visible; grouping lag leaves a temporary singleton rather than hiding a finding | API and UI fixture. |
| KEV catalog absent or advisory linkage unknown | Exploitation data unavailable/unknown; never claim an advisory is not exploited. A negative lookup is against the latest ingested catalog, not a claim about all exploitation. | API/UI fixture against SENTRA-8 contract. |
| API slow or unavailable | Loading state while pending, then error with correlation reference; manual Refresh can retry | Browser check with stopped API or delayed response. |
| Backfill interrupted or advisory updated concurrently | Backfill resumable; avoid overwriting a newer normalized vector/score | Backfill integration test. |
| Findings change between pages | Cursor deterministic for static data; concurrent updates can move entries, and Refresh restarts at page one | Pagination test and documented behavior. |
| Invalid filter or cursor | Bounded validation and normal problem response; no unbounded scan | API integration test. |
| Cross-tenant or wrong project | Existing 404-style boundary preserved; no finding or score leakage | Extend/retain SENTRA-21 isolation cases for new query combinations. |

## Security, observability, and rollout

- Authorization/isolation: any authenticated org member can read that org's project findings; org and project scope are enforced in the API query, never in the web UI alone. Filter/sort/cursor values are validated and parameterized. Limit is capped. Score data is global advisory information; findings and dependencies remain tenant data. Do not log access tokens or package lists.
- Observability: use existing correlation IDs and API request latency/error telemetry. CVSS parse failures log the version without raw vectors; the backfill prints processed row count. Dedicated per-filter/list-query metrics and malformed vector counts remain follow-up work for SENTRA-23/26. Check the measured local p95 before release.
- Rollout: additive migration, deploy scorer for new normalizations, run bounded idempotent backfill, then enable UI. Operator owns backfill and checks counts/errors. No data rewrite of findings is required. Update the YouTrack acceptance text after spec approval to distinguish already-covered isolation from new coverage, and link the spec.

## Acceptance criteria

- [ ] An authorized project member can reach a dedicated Findings page from the project page and see the vulnerability identifier, affected dependency/version, status, match quality, and CVSS score/category/version or an explicit unavailable value.
- [ ] The page defaults to open findings ordered by descending CVSS score with unavailable scores last; status and severity-category filters and a resolved view work across cursor pages.
- [ ] KEV context is shown from active SENTRA-8 entries, with listed, not listed and unavailable distinguished; the page makes no unsupported negative exploitation claim.
- [ ] Empty, loading, error, and manual Refresh states are clear; invalid filters and missing projects fail safely.
- [ ] The API enforces org/project boundaries for every filter/sort combination; SENTRA-21 findings list cases remain active and cover the new route parameters.
- [ ] At 25,000 findings in one project, the first-page API p95 is under 1 second on the recorded local stack and pagination returns each static finding exactly once.
- [ ] CVSS v3.0, v3.1, and v4.0 scores match official reference examples; malformed/missing vectors do not hide findings; existing advisories are backfilled safely.
- [ ] Playwright manual verification covers populated, empty, error, and resolved views; relevant screenshots are committed and linked in the PR.

## Verification

- Manual: start the documented local stack; sign in as a project member; open a project with parsed SBOM and findings; follow Findings link; verify severity order, unavailable labels, filters, resolved view, pagination, Refresh, and authorization. Stop API to confirm loading/error/retry. Sign in outside the org and confirm no findings are exposed. Capture Playwright screenshots of representative states.
- Automated: focused CVSS tests against official vectors and malformed cases; normalizer/backfill integration tests against real persisted rows; API integration tests for filter combinations, stable keyset pagination and errors; SENTRA-21 cross-tenant and same-slug cases; web tests for states. Use the canonical Task checks and `task fallow` when implementation is complete.
- Load/failure: 25,000-finding seeded project, warm API benchmark of at least 100 first-page reads, record p50/p95/p99 and query plan; interrupt/restart backfill; inspect that new normalizations cannot be overwritten by stale backfill work.

## Open questions and assumptions to validate

- **Verified:** `cvss` 3.6 supports the tested reference and malformed vectors in the running Python environment. Production vector distribution is unknown; sample it during rollout and investigate parse warnings.
- **Unknown:** normal traffic, concurrent user count, availability SLO and alert thresholds. Measure during rollout and address systemwide SLOs in SENTRA-26.
- **Verified locally:** joining and sorting 25,000 synthetic findings against stored vulnerability scores met p95 < 1 second at concurrency 1. Reassess under representative groups and concurrent traffic.
- **Known limitation:** an open page can become stale until manual Refresh, and concurrent score/finding updates may shift items between cursor pages.
- **Dependency check:** SENTRA-8 and SENTRA-12 merged while this feature was being implemented. Their catalog status and grouping behavior are covered by API integration tests and the browser fixture on the current branch.
