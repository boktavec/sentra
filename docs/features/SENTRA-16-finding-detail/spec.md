# SENTRA-16: Finding detail

- Status: Implemented; awaiting review
- YouTrack: http://localhost:8080/issue/SENTRA-16 ("[MVP] Finding Detail")
- Owner: Sentra project owner; API and web implementation
- Branch/worktree: `feature/SENTRA-16-finding-detail`
- Architecture decision: none required (no new service, datastore, dependency, or migration). Related: [ADR 0003](../../adr/0003-findings-as-derived-state-reconciled-per-project.md), [ADR 0004](../../adr/0004-kev-as-enrichment-plus-linked-vulnerability-rows.md), [ADR 0005](../../adr/0005-advisory-groups-over-advisories.md), [ADR 0006](../../adr/0006-cvss-severity-for-grouped-findings.md)

## Problem and outcome

A project member can see a compact list of findings (SENTRA-15), but cannot see why Sentra thinks the application is affected. They cannot see which advisory sources say so, or which signals make a finding important. Findings need evidence and provenance, and users must be able to tell source facts apart from Sentra-derived prioritization.

Done means an authorized org member can open any finding from the findings list and see one detail page for it. The page shows the affected dependency and version, a readable explanation of the match built from the stored matcher evidence, every advisory in the finding's SENTRA-12 group with its source provenance, and the existing risk factors (CVSS, KEV, match quality, dependency scope). It also states plainly that a Sentra priority is not yet calculated. A finding ID from another tenant or project returns the same 404 as a nonexistent one, and the SENTRA-21 isolation suite proves it.

## Scope

- In scope:
  - API route `GET /v1/orgs/:orgId/projects/:slug/findings/:findingId` returning a bounded, grouped finding detail.
  - Web detail page at `/orgs/:slug/projects/:projectSlug/findings/:findingId`, linked from every list card. It has a back link to the list and a plain link to the existing investigation page.
  - A readable "why affected" explanation built from the stored evidence, with a raw-JSON fallback.
  - Plain-text advisory details and allowlisted reference links.
  - Resolved findings and withdrawn advisories are viewable and clearly labeled.
  - SENTRA-21 isolation cases replacing `it.todo("detail route: cross-tenant read (SENTRA-16)")`.
  - API integration tests, web unit tests, a local detail benchmark, Playwright screenshots, and a learning note.
- Out of scope:
  - A Sentra risk/priority score and its factor breakdown (SENTRA-14).
  - Remediation guidance or AI summaries (SENTRA-19).
  - Markdown rendering of advisory text.
  - Preselecting a finding on the investigation page (follow-up).
  - Triage or editing of findings.
  - Pagination inside the detail resource.
  - New metrics or dashboards (SENTRA-23/26).
  - Any schema migration.
- Dependencies and related stories:
  - SENTRA-15 (list, CVSS), SENTRA-12 (grouping), SENTRA-8 (KEV), SENTRA-13 (matcher evidence), SENTRA-17 (investigation page), and SENTRA-21 (isolation suite) are merged on `main`.
  - SENTRA-14 is Ready and will extend the risk section additively.

## Decisions and alternatives

| # | Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- | --- |
| D1 | Risk factors | Show existing source signals as labeled risk factors: CVSS score/version/score-source advisory; KEV status plus catalog details; match quality/reason; dependency scope. The page states "Sentra priority is not yet calculated". | Block on SENTRA-14; pull minimal scoring into this story | Every value shown is a real fact, and the page keeps source facts separate from derived priority. SENTRA-14 adds a score and factor breakdown to the same section as an additive API change. |
| D2 | Resource identity | Any member finding ID opens the whole (purl, group). The scoped finding lookup runs before the group is expanded. | Single row only; new group-level ID in the URL | One ID scheme shared with SENTRA-17. The page matches the list item the user clicked, and links survive changes to the lead finding. It shows the *current* grouping, not the grouping when the link was made. |
| D3 | Untrusted advisory content | `details` is shown as escaped plain text, length-capped in the UI with an expand control. `refs` are links only when the URL parses as `http:`/`https:`, otherwise non-clickable text. Links use `rel="noopener noreferrer nofollow"` and `target="_blank"`. | Sanitized Markdown renderer (new dependency); omit details/refs | React escaping is the only rendering path and no dependency is added. Markdown shows as raw syntax. |
| D4 | Match explanation | The API returns each member's `evidence`, `matchQuality`, `matchReason`, and `matcherVersion` unchanged. The web formats `explicit_version`, `range`, `no_version_data`, and each unverifiable reason into readable text. An unknown `rule` falls back to a collapsible raw-JSON view. The matched range's `fixed` event is labeled "Fixed in (per advisory range)". | Raw JSON only; API composes explanation text | Meets the core outcome without putting presentation text in the API. The web must learn new rules, but the fallback means nothing is hidden. "Fixed in" is advisory data, not Sentra remediation advice. |
| D5 | Response bounds | Return only affected entries and ranges that match this finding's package. Cap at 50 member findings per group, 50 refs per advisory, and 64 KiB (65,536 UTF-8 bytes, cut at a character boundary) of `details` per advisory, each with an explicit `truncated` flag that the UI shows. | Unbounded; paginate members/refs | The data is controlled by third parties, so the response size must stay predictable. Nothing is cut silently. The cap values are **Assumed** (see Workload). |
| D6 | Entry points | List cards link to the detail page. The detail page links back to the list and to the investigation page, without preselection. | Add `?finding=` preselect to SENTRA-17's page now | The SENTRA-17 page has no preselect parameter (Verified below). Preselect is a follow-up. |
| D7 | Resolved/withdrawn | Viewable. Resolved members show status, `resolvedReason`, and `resolvedAt`. Withdrawn advisories show "Withdrawn by source" with the date. | 404 or hide | The route is reachable from the list's resolved filter, and history stays explainable. |
| D8 | Observability | Reuse existing request latency/error telemetry and correlation IDs. The error state shows the correlation reference. Never log evidence, package lists, or advisory text. | New per-route metrics | A read route needs no new operational surface. Dashboards stay with SENTRA-23/26. |
| D9 | Delivery | One PR, with implementation steps ordered API first. | Stacked PRs | Size M story. The steps stay separable if the PR grows. |
| D10 | Verification states | The isolation cases and Playwright states listed under Verification. | Fewer states | Covers the tenant and UI acceptance criteria. |

### Repository and third-party facts

- **Verified (repository, 2026-10-09):** the list query in `apps/api/src/findings.ts` groups findings by `(purl, COALESCE(group_id, vulnerability_id))` and picks a lead row: open first, then confirmed, then oldest `first_seen_at`, then `id`. It computes group CVSS as the highest scored member advisory, and `kevStatus` from `normalization_runs` (source `cisa-kev`, completed/published) plus active `kev_entries` (`removed_at IS NULL`) matched on CVE aliases. The detail header must use the same rules. Extract shared SQL fragments rather than copying them, so the list and the detail page cannot disagree.
- **Verified (repository):** stored `vulnerabilities.refs` is `[{type, url}]`. The pipeline validates every record before writing it (`services/pipeline/src/pipeline/normalize/process.py`, `model.validate`, against `packages/contracts/models/vulnerability.v1.json`): `references` is an array of objects with non-empty string `type` and `url`. Only the URL scheme is arbitrary (`javascript:`, `data:` and so on pass validation), so the http(s) allowlist stays. KEV stub advisories store `[]`. The API still treats a non-array `refs` as empty, as defence in depth.
- **Verified (repository):** finding `evidence` comes from `services/pipeline/src/pipeline/correlate/match.py`: `{package, dependencyVersion, rule, comparator, range?}`, where `rule` is `explicit_version`, `range` (with `range = {type, events[]}`), or `no_version_data`. The matcher version is currently `MATCHER_VERSION = 1`.
- **Verified (repository):** the correlator joins `sbom_dependencies d` to `vulnerability_affected a` on `a.ecosystem = d.ecosystem AND a.match_name = d.match_name` (`reconcile.py` `_CANDIDATES`). The detail page's package filter (D5) must use the same predicate, joining via `sbom_dependencies` on `(import_id, purl)` of the member finding. It must not compare purls as raw strings.
- **Verified (repository):** the SENTRA-17 investigation page (`apps/web/src/app/orgs/[slug]/projects/[projectSlug]/investigations/page.tsx`, `workspace.tsx`) reads no `searchParams`, and its selection is client state that starts at `null`.
- **Verified (repository):** `kev_entries` stores `date_added`, `due_date`, `known_ransomware_use`, `required_action`, `removed_at`, `catalog_version`. `vulnerabilities` stores `details`, `published_at`, `modified_at`, `withdrawn_at`, `refs`, `source_artifact_sha256`, `adapter_version`.
- No third-party library behavior is relied on beyond the existing stack. React's escaping of text children and the WHATWG `URL` parser in Node/browsers are standard platform behavior. The URL allowlist must still be unit-tested against `javascript:`, `data:`, `vbscript:`, mixed-case schemes, leading whitespace, and relative/garbage strings.

## Architecture and contracts

- **Affected components and ownership:** `apps/api` owns the route, scoping, and the bounded query. `apps/web` owns the page, the evidence formatting, and the URL allowlist. No pipeline, worker, schema, or event changes.
- **Request flow:** browser -> Next.js server component -> existing authenticated API client with the user token -> API `scopeTo` (membership in `orgId`) -> `findProject` (slug within org) -> scoped lookup `findings WHERE org_id = $1 AND project_id = $2 AND id = $3` (404 if absent; a malformed UUID returns the same 404) -> expand to the group's member findings for the same `purl` -> load advisories, filtered affected/ranges, KEV details -> bounded JSON -> page render.
- **API contract** (additive; error responses follow `packages/contracts/error-response.md`):

  ```text
  GET /v1/orgs/:orgId/projects/:slug/findings/:findingId
  200 {
    id,                       // the requested finding ID (not necessarily the lead)
    purl, version, ecosystem, scope,
    status,                   // group status, same rule as the list (open if any member open)
    firstSeenAt, lastSeenAt,  // group min/max, same as the list
    groupId | null,
    vulnerability: { id, source, sourceId, aliases, summary,          // canonical advisory
                     cvssScore, cvssVersion, severityCategory, cvssSource | null },
    kevStatus: "listed" | "not_listed" | "unavailable",
    kev: null | { cveId, vendorProject, product, name, dateAdded, dueDate,
                  knownRansomwareUse, requiredAction, catalogVersion }[],   // active entries only, when listed
    members: [{
      id, status, resolvedReason, resolvedAt, firstSeenAt, lastSeenAt, importId,
      matchQuality, matchReason, matcherVersion, evidence,
      advisory: { id, source, sourceId, aliases, summary, details, detailsTruncated,
                  publishedAt, modifiedAt, withdrawnAt, cvssScore, cvssVersion,
                  refs: [{ type, url }], refsTruncated,
                  affected: [{ packageName, versions, versionsTruncated?, ranges: [{ type, events: [{ type, version }] }] }] }
    }],
    membersTruncated: boolean
  }
  404 problem: not found / other tenant / other project / malformed ID (indistinguishable)
  ```

  Implementation may rename fields for consistency with the existing list response, but must keep these semantics. Member order is open before resolved, then confirmed before unverifiable, then `first_seen_at`, then `id`, which matches the list's lead rule. The requested finding is always included, even if it would fall beyond the member cap. If a long explicit `versions` list would blow the bounds, cap it as well (Assumed: 200 versions) with a flag.

- **Storage:** no migration. Existing indexes are `findings` PK (scoped lookup), `vulnerability_group_members`, `vulnerability_affected_vuln_idx`, and `vulnerability_ranges` PK. Confirm with `EXPLAIN ANALYZE` on the benchmark dataset. Add an index only if measurement shows a need, and document it if so.
- **Web:** new `apps/web/src/app/orgs/[slug]/projects/[projectSlug]/findings/[findingId]/page.tsx`. Add `getFinding` in `apps/web/src/lib/findings.ts`. Put pure helpers (evidence formatter, safe-URL check) in a small module with unit tests. List cards in `findings/page.tsx` link to the detail page. The page sections are header (CVE or source ID, status, dependency/version, scope), risk factors, why affected, advisories and provenance, and references.
- **Compatibility:** purely additive. The list response is unchanged except that cards gain a link. Rollback is reverting the PR; no data is affected.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | **Unknown** | No production workload established | Existing API request telemetry; SENTRA-26. |
| Concurrent users | **Unknown** | Same | Benchmark at concurrency 1 and record it. |
| Group size / advisory size | Typically 1-3 members; caps of 50 members, 50 refs, 64 KiB (bytes) details, 200 explicit versions | **Assumed** (user-approved defaults) | Query the local advisory corpus for max/p99 group size, refs count, details length, and versions length. Record the results in the PR and adjust the caps if real data routinely truncates. |
| Detail API latency | p95 < 1 s on the local stack | Owner-selected lab target (same as SENTRA-15), not an SLO | Extend the `apps/api` bench (`pnpm run bench:findings` pattern) with a seeded large group at the caps plus the 25,000-finding project. Run 10 warm-ups and 100 timed requests, and record p50/p95/p99, machine, and dataset. |
| Availability and recovery | **Unknown** SLO; bounded web API timeout (existing 5 s) and visible error state | Existing client behavior | Stop the API and verify the error state with a correlation reference. |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Malformed, nonexistent, other-project or other-tenant finding ID | Identical 404 problem shape; no group, advisory or KEV data leaks | SENTRA-21 isolation cases and API integration tests |
| Requested ID is a non-lead member | Same grouped view as the lead's ID; `id` echoes the requested finding | API integration test |
| Ungrouped advisory (`group_id` null) | Single-member view; `groupId: null` | API test |
| Grouping lag | Member temporarily appears as its own singleton (same as the list) | Documented limitation |
| Group exceeds caps | Requested member always present; `membersTruncated`/`refsTruncated`/`detailsTruncated` set; UI says "N more not shown; see source advisory" | API test with seeded oversized group; Playwright screenshot |
| Advisory has affected entries for other packages | Only entries matching this package (ecosystem + match_name) are returned | API test |
| Withdrawn advisory | Shown with "Withdrawn by source" and its date | API and web tests |
| Resolved member or resolved group | Viewable; status, reason, date shown | API test; Playwright screenshot |
| Unverifiable match | Explicit uncertainty with plain reason text, never "confirmed" | Web formatter tests; screenshot |
| Unknown evidence `rule` or unexpected shape | Collapsible raw-JSON fallback; page does not crash | Web formatter test |
| Range with no `fixed` event | No "Fixed in" line; never implies a fix exists | Web formatter test |
| KEV catalog never ingested or no CVE linkage | "Exploitation data unavailable"; never claims "not exploited". `not_listed` wording: "Not listed in ingested CISA KEV catalog" | API/web tests reusing list rules |
| Non-HTTP ref URL (`javascript:`/`data:` scheme); null or malformed ref parts handled defensively | Rendered as non-clickable text | Web unit tests |
| Null `summary`/`details`/`published_at`, missing CVSS | Field omitted or "unavailable", no crash | Web tests |
| API slow or unavailable | Loading state, then error with correlation reference; navigation retries | Manual/Playwright |
| Finding changes or regroups between list and detail | Detail shows current state; 404 only if the row is gone (rows are not deleted today) | Documented behavior |

## Security, observability, and rollout

- **Authorization and tenant isolation:** any current org member may read. Scope by org membership, then project slug within the org, then `findings.org_id/project_id/id` before any expansion. Group expansion is restricted to findings with the same `org_id`, `project_id` and `purl`. Advisory, group and KEV data are global, but they are reached only through an authorized finding. All parameters are parameterized; the finding ID is validated as a UUID (malformed returns 404, not 400, to keep responses uniform).
- **Untrusted content:** advisory text and refs come from third parties. Render them only as React text. Allowlist link schemes. Never use `dangerouslySetInnerHTML`. Response caps bound the payload.
- **Sensitive data:** do not log evidence, purls/package lists, advisory text or tokens. Use existing correlation IDs.
- **Logs/metrics/alerts:** existing request telemetry only (D8).
- **Rollout and rollback:** no migration and no flag; deploy the API and web together. Rollback is reverting the PR. Operational owner: API/web maintainers.

## Acceptance criteria

- [ ] A user can open a finding from the findings list; every list card links to its detail page, and the detail page links back to the list and to the investigation page.
- [ ] The page displays the affected package purl, version, ecosystem and dependency scope.
- [ ] The page shows the associated advisory information: canonical advisory, aliases, summary, plain-text details (capped with expand), published/modified/withdrawn dates, and allowlisted references.
- [ ] Source provenance is visible: every advisory in the group with its source and source ID, the advisory that supplied the CVSS score, and each member's matcher evidence explained in readable form (raw-JSON fallback for unknown rules).
- [ ] Risk factors are visible (Sentra priority pending SENTRA-14): CVSS score/version/category or unavailable, KEV status, match quality/reason and dependency scope, with an explicit "Sentra priority is not yet calculated" note.
- [ ] CISA KEV status is visible; when listed, catalog details (date added, due date, known ransomware use, required action) are shown; no unsupported negative exploitation claim.
- [ ] Any member finding ID of a group returns the same grouped view; responses are bounded by the agreed caps with visible truncation.
- [ ] Unauthorized users cannot retrieve another tenant's or another project's finding by manipulating an identifier; all such requests return the same 404 as a nonexistent ID.
- [ ] `apps/api/src/tenant-isolation.integration.test.ts` has detail-route cases replacing the `findings` todo, and its route-coverage check passes.
- [ ] Detail API p95 < 1 s on the recorded local stack for a seeded capped group.
- [ ] UI is manually verified with Playwright, and screenshots of the agreed states are committed under `docs/features/SENTRA-16-finding-detail/screenshots/` and linked in the PR by commit-SHA permalinks.

## Implementation steps

Each step is independently verifiable. Run the relevant Task commands after each step.

1. **Shared grouping SQL.** Extract the list query's group/lead, group CVSS and KEV-status logic in `apps/api/src/findings.ts` into reusable fragments or functions, without changing behavior. *Depends on:* none. *Result:* the list output is identical. *Tests:* the existing `findings.integration.test.ts` and isolation suite pass unchanged.
2. **Detail store method.** Add `get(tenant, slug, findingId)` to the finding store. It does the scoped lookup, then expands members (capped at 50 with the requested ID always included), loads advisories with details/refs caps, filters affected entries and ranges via the `sbom_dependencies` match predicate, and adds KEV details. *Depends on:* 1. *Result:* a typed detail object or 404 `AppError`. *Tests:* API integration tests against real Postgres for lead vs non-lead ID, ungrouped, multi-advisory group, package filtering, all caps and flags, withdrawn advisory, resolved member, KEV listed/not_listed/unavailable, and unverifiable evidence.
3. **Route.** Register `GET /v1/orgs/:orgId/projects/:slug/findings/:findingId` in `findings-routes.ts` with `scopeTo` and UUID validation (malformed returns 404). *Depends on:* 2. *Result:* the HTTP contract above. *Tests:* route-level integration tests for 200, 404 variants and the unauthenticated 401.
4. **Tenant isolation cases.** In `tenant-isolation.integration.test.ts`, add the route to the route table and replace the SENTRA-16 todo with: cross-tenant ID, same-slug project in another org, finding from another project in the same org, nonexistent ID, malformed ID. Assert identical 404 bodies and no leaked fields. *Depends on:* 3. *Tests:* the suite and its coverage check pass.
5. **Benchmark and corpus sample.** Extend the API bench with a detail scenario: a capped large group inside a 25,000-finding project, 10 warm-ups and 100 timed requests. Query the local corpus for group size, refs count, details length and versions length. *Depends on:* 2-3. *Result:* p50/p95/p99 and corpus numbers recorded in this spec and the PR; caps adjusted only with a stated reason. *Tests:* p95 < 1 s.
6. **Web data client and helpers.** Add `getFinding` to `apps/web/src/lib/findings.ts` with types. Add pure helpers: `safeHref(url)` (http/https only) and an evidence formatter covering `explicit_version`, `range` (introduced/fixed/last_affected, "Fixed in (per advisory range)"), `no_version_data`, the unverifiable reasons, and the unknown-rule fallback. *Depends on:* 3. *Tests:* unit tests for every rule/reason, ranges without `fixed`, malicious and odd URLs, and null fields.
7. **Detail page and list links.** Add the `[findingId]/page.tsx` server page with the sections, plain-text details with expand, truncation notices, resolved/withdrawn labels, loading/error/not-found states, and back and investigation links. Link each list card. *Depends on:* 6. *Tests:* web tests for rendering states consistent with existing web test patterns.
8. **Browser verification and docs.** Use Playwright on the local stack to capture: confirmed range match with "Fixed in", unverifiable match, KEV listed with details, multi-advisory group, resolved finding, truncation shown, not-found, and API error. Commit the screenshots under this feature folder. Add a learning note under `docs/learning/`. Update this spec's status and measurements. *Depends on:* 7.

## Verification

- **Manual checks:** start the documented local stack. Sign in as a member, open Findings, click a card, and check every section against the database for that finding. Open the page via a non-lead member ID and confirm it shows the same view. Open a resolved finding from the resolved filter. Paste another org's finding ID into the URL and confirm Not found. Stop the API and confirm the error state with a reference.
- **Automated:** real-Postgres API integration tests (step 2-3), the SENTRA-21 isolation cases (step 4), and web unit/render tests (steps 6-7). Run `task check`, `task test:integration`, and `task fallow`, resolving fallow findings by fixing them.
- **Load:** the detail benchmark (step 5), with results recorded.

## Measurements (local, 2026-10-09)

- `pnpm run bench:findings` in `apps/api`, scratch database on the local Postgres, concurrency 1, 10 warm-ups plus 100 timed requests, 25,052 findings, one group of 52 advisories at the caps: detail p50 26 ms, p95 31-33 ms, p99 34-37 ms; list p95 74.7 ms (74.4 ms before the shared-SQL refactor).
- Corpus sample: only 16 real advisories are loaded locally (max group size 2, no details or explicit versions), so the caps are not validated.

## Implementation notes

- No `loading.tsx`: it makes Next send 200 before `notFound()`, so unknown IDs would not be a real 404.
- The error screenshot comes from a second dev server whose API address refuses connections (`NEXT_DIST_DIR` gives it its own build directory), so it shows the page-level unavailable state with a reference.
- The truncation notices do not say "N more", since the API returns no member count.

## Follow-ups (not in this story)

- Investigation page preselect via `?finding=<id>`, loading an off-page finding through this detail route (SENTRA-17 area).
- SENTRA-14: add a Sentra priority score and factor breakdown to the risk section.
- Optional sanitized Markdown rendering for advisory details, if raw syntax proves a real usability problem.

## Open questions and assumptions to validate

- **Assumed:** caps (50 members, 50 refs, 64 KiB (bytes) details, 200 explicit versions). Validate against the local corpus in step 5.
- **Assumed:** the list's grouping rules can be shared without a measurable list regression. Validate with the existing list benchmark (p95 stays under 1 s) after step 1.
- **Unknown:** production traffic, concurrency and availability targets (SENTRA-26).
- **Known limitations:** the page shows current grouping only; KEV `not_listed` refers to the latest ingested catalog; Markdown appears as raw text.
