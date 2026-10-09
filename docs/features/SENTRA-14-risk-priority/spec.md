# SENTRA-14: Calculate MVP risk priority

- Status: Implemented (awaiting review)
- YouTrack: http://localhost:8080/issue/SENTRA-14 ("[MVP] Calculate MVP Risk Priority")
- Owner: Sentra project owner; API (query and contract) and web (list badge, detail breakdown)
- Architecture decision: ADR 0008 (to be written in step 1; see Decisions)

## Problem and outcome

A project member can list findings (SENTRA-15) and inspect one (SENTRA-16), but the only ordering is CVSS base severity. Severity alone does not say what attackers use or whether the vulnerable package actually ships. The detail page says "Sentra priority is not yet calculated".

Done means every grouped finding item (one per dependency and advisory group, per SENTRA-12) has a deterministic Sentra priority tier P1 to P4 with a model version and an explanation of each contributing factor. The findings list sorts by priority by default and can filter by tier. The detail page shows the tier and factor breakdown. Missing enrichment yields a defined tier, never an error or a random order.

## Scope

- In scope:
  - Priority model v1: ordered rules over group CVSS, KEV status, dependency scope and match quality, computed at read time in the shared finding SQL.
  - List API: `sort=priority` (new default) and an optional `priority=p1|p2|p3|p4` filter; the existing `severity`/`newest` sorts and the severity filter remain.
  - List and detail responses gain a `priority` object (tier, model version, factors).
  - Web: tier badge on list cards, a priority sort/filter control, and the detail page "Sentra priority" section replacing the placeholder note.
  - Table-driven real-Postgres tests over the full input matrix, API and web tests, re-run of the SENTRA-15 benchmark, model documentation, ADR, learning note.
- Out of scope:
  - Stored tiers, tier history, or change notifications.
  - Numeric scores, ML, EPSS or other new enrichment feeds; asset criticality or internet exposure (no such tenant data exists).
  - Using `known_ransomware_use` or KEV due dates in the model (shown on detail already; candidate for a later model version).
  - User overrides, triage, or per-tenant model tuning.
  - Feeding priority into SENTRA-17 investigations' AI context (follow-up).
- Dependencies and related stories: SENTRA-8 (KEV), SENTRA-12 (groups), SENTRA-13 (findings), SENTRA-15 (list), SENTRA-16 (detail) are Done. SENTRA-21 isolation suite covers the list and detail routes and is extended for the new parameters.

## Decisions and alternatives

| # | Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- | --- |
| D1 | Output form | Tiers P1 to P4 from ordered rules; group CVSS breaks ties within a tier | Additive 0-100 score; score plus derived tiers | Most transparent; KEV dominates by construction; no false precision. Order within a tier is coarse, so CVSS sorts it. A numeric score can be added later without changing finding identity. |
| D2 | Where computed | At read time in `apps/api/src/finding-sql.ts`, shared by list and detail; `PRIORITY_MODEL_VERSION = 1` constant in code | Stored on `findings` by the correlator; separate derived table and job | Inputs (group CVSS, KEV) change outside the correlator (ADR 0004: KEV does not wake it), so a stored tier would go stale and need new wake-ups and backfills. Read time follows ADR 0006. Cost: the sort is over a computed expression; benchmark re-run is mandatory. No tier history. |
| D3 | Rule table v1 | See "Priority model v1" below | CVSS unavailable gives P4; unverifiable lowers a tier | Unknown severity and unverifiable matches stay visible instead of looking safe; exposure moderates without hiding. |
| D4 | List contract | `sort=priority` default, `priority` filter, keep `severity`/`newest` sorts and severity filter | Opt-in priority sort; priority sort without filter | Delivers "most important first" by default; "P1 only" is the likely first triage action. Default order changes for clients that omit `sort` (documented; the web investigations page already passes `sort=newest`). |
| D5 | Single source of truth | SQL computes the tier and returns factor flags (`base_reason`, `scope_adjusted`); TS only maps flags to labels and never re-decides | TS rule table that generates SQL; hand-written SQL plus TS copy with a parity test | No duplicated logic, so list order, filter and displayed tier cannot disagree. "Unit tests" for the calculation are table-driven tests against real Postgres over every input combination. |
| D6 | Delivery | One PR (size M), API steps first | Stacked PRs | Small, coherent change; steps remain separable if the PR grows. |
| D7 | ADR | Record ADR 0008 "Read-time, rule-based risk priority" | Spec only | The model and its read-time placement are lasting decisions other stories (SENTRA-17 AI context, future model versions) build on. |

### Repository facts

- **Verified (repository, 2026-10-09):** `findingSql` in `apps/api/src/finding-sql.ts` builds one row per `(purl, COALESCE(group_id, vulnerability_id))`. It picks a lead row (open, then confirmed, then oldest, then id), takes group CVSS as the highest scored member advisory in a `scored` CTE before paging, and computes `kev_status` in the final SELECT after paging. The list (`findings.ts`) and detail (`finding-detail.ts`) both use it.
- **Verified (repository):** the inputs available per item are `cvss_score` (nullable, 0.0 to 10.0), `kev_status` (`listed | not_listed | unavailable`), lead `scope` (`required | optional | excluded`) and lead `match_quality` (`confirmed | unverifiable`). There is no direct/transitive flag, asset criticality or EPSS data.
- **Verified (repository):** the list cursor is base64url JSON `[sort, status, severity, score, time, id]` validated in `decodeCursor`; `findings-routes.ts` validates `sort` against `severity | newest` and defaults to `severity`.
- **Verified (repository):** `apps/web/src/lib/investigations.ts` calls the list with `sort=newest` explicitly, so the default change does not affect it. The detail page shows `Sentra priority is not yet calculated.` (`data-testid="priority-note"`) in `detail-view.tsx`.
- **Implication (must be handled):** priority sorting and filtering need `kev_status` before pagination. The KEV expression must move from the final SELECT into the pre-paging CTE, so it is evaluated for every item in the project rather than only the page. The "catalog completed" check is query-constant and should be evaluated once (for example, a single-row CTE), not per row. The benchmark decides whether this is fast enough.
- No third-party library behavior is relied on. Postgres `CASE` and `ORDER BY` semantics are standard.

## Priority model v1

Evaluated per grouped item, in SQL, in this order:

1. **Base tier** (`base_reason`):
   | Condition | Base | `base_reason` |
   | --- | --- | --- |
   | `kev_status = 'listed'` | P1 | `kev_listed` |
   | otherwise CVSS >= 7.0 (high or critical) | P2 | `cvss_high` |
   | otherwise 4.0 <= CVSS < 7.0 (medium) | P3 | `cvss_medium` |
   | otherwise CVSS is null (unavailable) | P3 | `cvss_unavailable` |
   | otherwise CVSS < 4.0 (low or none) | P4 | `cvss_low` |
2. **Exposure adjustment** (`scope_adjusted`): if lead scope is `optional` or `excluded`, the tier is lowered by one, never below P4. `scope_adjusted = true` only when the tier actually changed (a P4 base stays P4 with `scope_adjusted = false`; the scope factor still shows).
3. **Match quality:** `unverifiable` does not change the tier; it is reported as a factor.
4. **KEV unavailable** (no completed catalog or no CVE linkage) is scored like `not_listed`; the explanation says "Exploitation data unavailable", never "not exploited".
5. **Order for `sort=priority`:** tier ascending (P1 first), then group CVSS descending with null last, then `group_first_seen_at` descending, then `id`. This extends the existing keyset.

Thresholds reuse `category()` boundaries (critical >= 9.0, high >= 7.0, medium >= 4.0). Status does not affect the tier: resolved items carry a tier too (descriptive), and the default `status=open` filter keeps them out of the default view.

A model change (any rule, threshold or input) bumps `PRIORITY_MODEL_VERSION` and updates the docs, ADR and matrix tests. Finding identity and stored data are untouched.

## Architecture and contracts

- **Components and ownership:** `apps/api` owns the tier expression, query, contract and validation. `apps/web` owns labels and presentation. No pipeline, worker, event, or migration changes.
- **Flow:** web -> API (`scopeTo`, `findProject`) -> `findingSql` computes lead, group CVSS, KEV status and tier before paging -> filter, sort and page -> response with `priority`.
- **API (additive except the default sort):**
  - `GET /v1/orgs/:orgId/projects/:slug/findings`: `sort=priority|severity|newest` (default `priority`); `priority=p1|p2|p3|p4|all` (default `all`). Invalid values return the existing `invalid_input` problem with `reason` `sort` or `priority`.
  - Cursor becomes `[sort, status, severity, priority, tier, score, time, id]`. The tier is validated as an integer 1 to 4, the priority filter must match the request, and old-format cursors are rejected with `invalid_input` (clients restart from page one, as on any filter change).
  - List items and the detail response gain:
    ```text
    priority: {
      tier: "P1" | "P2" | "P3" | "P4",
      modelVersion: 1,
      baseReason: "kev_listed" | "cvss_high" | "cvss_medium" | "cvss_unavailable" | "cvss_low",
      scopeAdjusted: boolean,
      factors: {
        kev: "listed" | "not_listed" | "unavailable",
        cvss: { score: number | null, category: SeverityCategory },
        scope: "required" | "optional" | "excluded",
        matchQuality: "confirmed" | "unverifiable"
      }
    }
    ```
    `factors` repeat values already in the response so the explanation is self-contained. The API returns codes, not prose.
- **Web:** `finding-format.ts` gains pure label helpers (`priorityLabel`, `explainPriority(priority)` that maps `baseReason`, `scopeAdjusted` and factors to fixed sentences, for example "Listed in CISA KEV: base P1", "Scope excluded: lowered one tier", "Exploitation data unavailable", "Severity unavailable: treated as P3", "Version could not be verified"). The list page adds the badge and a Priority option in the sort and filter controls, and defaults to priority. The detail page replaces the placeholder note with the tier, model version and factor list, keeping the existing risk facts.
- **Docs:** add a "Risk priority" section to `packages/contracts/models.md` (rules, version, meaning of each factor); ADR 0008.
- **Compatibility:** clients omitting `sort` now get priority order (documented in the PR and models.md). The new field is additive. Rollback is reverting the PR; no data changes.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | **Unknown** | No production workload | Existing API telemetry; SENTRA-26 |
| Concurrent users | **Unknown** | Same | Benchmark at concurrency 1, recorded |
| Project size | Up to 25,000 findings in one project | SENTRA-15 acceptance case | Extended benchmark dataset with KEV-listed items and mixed scopes |
| First-page list latency, `sort=priority` | p95 < 1 s on the local stack | Owner-selected lab target (SENTRA-15), not an SLO; previous `sort=severity` p95 was 74.7 ms | `pnpm run bench:findings` extended for `sort=priority` and `priority=p1`: 10 warm-ups, 100 timed requests; record p50/p95/p99, machine, dataset, `EXPLAIN ANALYZE` |
| Detail latency | Unchanged target (p95 < 1 s) | SENTRA-16 | Existing detail bench still passes |
| Availability and recovery | **Unknown** SLO; existing 5 s web client timeout and error state | Existing behavior | No new failure modes beyond the query |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| No CVSS on any member | Base P3 `cvss_unavailable`, sorted after scored P3 items | Matrix test |
| KEV catalog never ingested or no CVE alias | Scored as not listed; factor `unavailable`; UI says data unavailable | No-CVE-alias path: matrix test, web label tests. **Gap:** "catalog never ingested" is not integration-tested because `normalization_runs` is global in the shared test database; the branch is a one-line check in `kevStatusSql` |
| KEV entry removed (tombstoned) | Not listed; tier drops on next read | API integration test |
| KEV listed and scope excluded | P2, `scope_adjusted = true` | Matrix test |
| Low CVSS and excluded | P4, `scope_adjusted = false` | Matrix test |
| Unverifiable match | Tier unchanged; factor shown | Matrix and web tests |
| CVSS exactly 7.0, 4.0, 0.0 | P2, P3, P4 (boundaries inclusive as in `category()`) | Matrix boundary rows |
| Group membership or KEV changes between pages | Item may move tiers; cursor stays deterministic for static data; Refresh restarts | Pagination test; documented |
| Every item in one tier and score | Order falls back to time and id; each item returned exactly once | Pagination test |
| Invalid `sort`, `priority`, or old-format cursor | `invalid_input` problem, no scan | API tests |
| Resolved items | Tier computed; visible only with `status=resolved|all` | API test |
| Cross-tenant or wrong project with any new parameter combination | Same 404 boundary; no tier or factor leakage | SENTRA-21 cases extended |

## Security, observability, and rollout

- **Authorization and isolation:** unchanged scoping (org membership, project within org, `findings.org_id/project_id` in the base WHERE). New parameters are allow-listed and parameterized. The tier is derived from data the caller can already read, so it exposes nothing new.
- **Sensitive data:** no new logging; never log package lists or evidence.
- **Observability:** existing request latency and error telemetry with correlation IDs. The response carries `modelVersion` so screenshots and bug reports identify the model. Per-tier counts and dashboards are left to SENTRA-23/26.
- **Rollout and rollback:** deploy the API before or with the web app (the new web sends `sort=priority` by default and reads `priority.tier`; an older API rejects `sort=priority` with 400 `invalid_input`, so the new web needs the new API). Cursors from before this change give `invalid_input` until the user reloads page one. No migration, no flag. Rollback is reverting the PR. Owner: API/web maintainers.

## Acceptance criteria

- [x] Every list item and detail response carries a deterministic `priority` (tier P1 to P4, `modelVersion`, `baseReason`, `scopeAdjusted`, factors) computed by one SQL expression.
- [x] A KEV-listed item ranks P1 (or P2 when scope is optional/excluded) above any non-listed item of the same exposure.
- [x] Missing CVSS or KEV data yields the defined tier and an "unavailable" factor, never an error, null tier, or unsupported negative claim.
- [x] The list defaults to `sort=priority`, supports `priority=p1..p4`, keeps `severity`/`newest` sorts and the severity filter, and pages every static item exactly once.
- [x] The detail page shows the tier, model version and a readable factor breakdown in place of "Sentra priority is not yet calculated"; list cards show a tier badge.
- [x] Table-driven real-Postgres tests cover all 108 input combinations (KEV 3 x CVSS category 6 x scope 3 x match quality 2) plus CVSS boundary values.
- [x] The model is documented in `packages/contracts/models.md` and ADR 0008, versioned, and changing it does not alter finding identity.
- [x] At 25,000 findings, first-page `sort=priority` p95 < 1 s on the recorded local stack.
- [x] SENTRA-21 isolation cases cover the new parameters.

## Implementation steps

1. **ADR and model docs.** Write `docs/adr/0008-read-time-rule-based-risk-priority.md` and the "Risk priority" section in `packages/contracts/models.md`. Depends on: none. Result: model v1 documented. Tests: none.
2. **Tier expression in shared SQL.** In `finding-sql.ts`, move KEV status into the pre-paging CTE (catalog-completed check evaluated once), add `priority_tier`, `priority_base_reason`, `priority_scope_adjusted` columns from one CASE expression, export `PRIORITY_MODEL_VERSION`, extend `FindingRow`. Depends on: 1. Result: list and detail rows carry tier data with no behavior change to other fields. Tests: new table-driven integration test seeding all 108 combinations plus boundaries and asserting tier, reason and flag; existing findings and detail integration tests still pass.
3. **List API contract.** Add `sort=priority` (default), `priority` filter, new cursor format and validation, and the `priority` response object (list and detail). Depends on: 2. Result: API contract as specified. Tests: API integration tests for filter/sort combinations, keyset pagination exactly-once under priority sort, invalid parameters and old cursors, tombstoned KEV; extend SENTRA-21 isolation cases.
4. **Benchmark.** Extend `apps/api/bench/findings.ts` with KEV-listed items and mixed scopes; measure `sort=priority` and `priority=p1`; capture `EXPLAIN ANALYZE`. Depends on: 3. Result: recorded numbers in this spec and the PR; if p95 >= 1 s, stop and escalate (do not denormalize without a decision). Tests: n/a.
5. **Web list and detail.** Add label helpers in `finding-format.ts`, list badge and sort/filter controls defaulting to priority, detail "Sentra priority" section. Update `apps/web/src/lib/findings.ts` types. Depends on: 3. Result: UI as specified. Tests: unit tests for every `baseReason`, `scopeAdjusted` and unavailable-factor label; update Playwright specs (`findings.spec.ts`, `finding-detail.spec.ts`) for badge, default order, filter and detail breakdown; screenshots under `docs/features/SENTRA-14-risk-priority/screenshots/`.
6. **Docs and learning note.** Update this spec with measurements and any changes, add `docs/learning/SENTRA-14-risk-priority.md`. Depends on: 4, 5.

## Measurements (step 4)

- **Verified (2026-10-09, re-recorded after review finding R1):** `pnpm run bench:findings` (`BENCH_EXPLAIN=1` also prints `EXPLAIN (ANALYZE, BUFFERS)`). Machine: Apple M5 Pro, 64 GB, Postgres 17.10 in Docker (local stack), API in-process via `inject`, concurrency 1, 10 warm-ups then 100 timed requests, first page of 50.
- Dataset (representative global corpus): 25,000 findings in one project over 5,000 advisories in 2,500 two-member groups, plus 100,000 filler advisories, 1,000 active KEV entries (matching advisory aliases), scopes mixed across required, optional and excluded, 1/7 resolved.
- **Lesson:** the first benchmark used 5 advisories and hid a per-item sequential scan of `vulnerabilities`, caused by `a.id = x OR a.id IN (subquery)` in `advisoriesOfGroup`. The helper now uses `a.id IN (SELECT x UNION ALL SELECT ... group members)`, which uses the primary key. The reviewer measured the old form at 13.4 s with 5,000 advisories and 285 s at about 110,000.

| Scenario | p50 | p95 | p99 |
| --- | --- | --- | --- |
| `sort=priority` (default) | 315.2 ms | 321.1 ms | 327.3 ms |
| `sort=priority&priority=p1` | 331.5 ms | 338.6 ms | 341.8 ms |
| `sort=severity` (unchanged sort) | 120.3 ms | 125.0 ms | 131.4 ms |
| detail (25,052 findings, group at the caps) | 22.9 ms | 29.3 ms | 30.2 ms |

p95 is well below the 1 s target; the stop rule did not trigger. `EXPLAIN ANALYZE` of the priority page shows 345 ms execution and no sequential scan of `vulnerabilities` or `kev_entries`. Priority costs about 2.5x the severity sort because KEV status is evaluated for every group before paging.

## Verification

- Manual: start the local stack; sign in as a project member; open a project with findings including a KEV-listed CVE, an unscored advisory and an optional-scope dependency. Confirm default priority order, badges, `P1` filter, switching to severity/newest, pagination, and the detail breakdown text. Confirm another org's user gets 404. Capture Playwright screenshots.
- Automated: matrix integration tests (step 2), API contract and isolation tests (step 3), web unit and Playwright tests (step 5). Run `task check`, `task test:integration`, and `task fallow`, resolving every fallow finding.
- Load: extended `bench:findings` as in Workload.

## Open questions and assumptions to validate

- **Assumed:** moving KEV evaluation before paging keeps the 25,000-finding first page under 1 s. Validated by step 4; escalate if not.
- **Assumed:** the lead row's scope represents the group (all members share the same purl and dependency). Revisit if SBOM imports start reporting differing scopes for one purl.
- **Unknown:** traffic, concurrency and SLOs (SENTRA-26).
- **Known limitation:** no tier history; a tier can change between reads when KEV, CVSS or grouping changes.
- **Follow-up candidates:** `known_ransomware_use` as a factor, EPSS, direct/transitive exposure once SBOM parsing provides it, priority in SENTRA-17 AI context.
