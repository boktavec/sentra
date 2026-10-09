# SENTRA-14: MVP risk priority

Spec: [docs/features/SENTRA-14-risk-priority/spec.md](../features/SENTRA-14-risk-priority/spec.md). Decision: [ADR 0008](../adr/0008-read-time-rule-based-risk-priority.md).

## What was built

Every grouped finding gets a Sentra priority tier P1 to P4 with a model version and the factors behind it. The findings list sorts by priority by default and filters by tier; list cards show a badge and the detail page lists the reasons in plain language. Rules: CISA KEV listing means P1; otherwise CVSS high, medium or low means P2, P3 or P4 (unscored is P3); an optional or excluded dependency scope lowers the tier one step, never below P4. Unverifiable matches and missing KEV data are reported but never change or hide a tier.

## Why it is designed this way

- **Rules, not a score.** A small ordered rule table is easy to explain ("Listed in CISA KEV: base P1"), and KEV dominates by construction. A 0-100 score would suggest precision the inputs do not have. CVSS orders items inside a tier.
- **Computed at read time, in one SQL expression.** KEV and CVSS change outside the correlator (ADR 0004 and 0006), so a stored tier would go stale and need new wake-ups and backfills. The list and detail share the SQL, so the displayed tier, the filter and the order cannot disagree. The web only turns returned codes into sentences.
- **Missing data has a defined answer.** No CVSS is P3 so it stays visible; KEV "unavailable" is scored as not listed but worded "Exploitation data unavailable", never "not exploited".
- **Versioned.** `modelVersion` is returned with every tier, so a screenshot or bug report identifies the rules in force. A rule change bumps it and the docs and matrix tests.

## Alternatives considered

Additive numeric score; storing the tier on `findings` or in a derived table; opt-in priority sort; a TS rule table that generates SQL, or a duplicated TS copy with a parity test.

## Tradeoffs

- Sorting by tier needs KEV status for every item in the project before paging. Local benchmark at 25,000 findings over 105,000 advisories and 1,000 KEV entries: first-page p95 321 ms for `sort=priority`, against 125 ms for `sort=severity`. Comfortable against the 1 s lab target, but it is real extra work per request.
- A benchmark with a toy corpus hid a per-item sequential scan (an `OR` between an id comparison and an `IN` subquery defeats the primary-key index). The first run, with 5 advisories, looked fine; the reviewer's realistic data showed seconds to minutes. Benchmark with production-shaped reference data, and read the plan for sequential scans.
- No tier history: a tier can move between reads when KEV, CVSS or grouping changes. Refresh restarts the list; the cursor is deterministic for static data.
- The default sort changed from severity to priority; the cursor format changed, so old cursors are rejected and clients restart at page one.
- Order inside a tier is coarse (CVSS, then age).

## Scaling implications

The cost grows with the number of groups in one project, not with page size. If a project's list outgrows the budget, denormalizing the tier needs its own decision (ADR 0008) because it reintroduces staleness.

## Failure and security considerations

Tenant scoping is unchanged (`org_id` and `project_id` in the base filter, allow-listed and parameterized `sort` and `priority` values); the tier is derived from data the caller can already read. The isolation suite covers the new parameters. The cursor carries the tier, validated as an integer 1 to 4, and is tied to the request's filters.

## Key concepts

Derived data versus stored data (and when staleness decides between them); single source of truth across API and UI; defined behavior for missing inputs; versioned decision models; keyset pagination over a computed sort key; table-driven tests over the full input matrix (here, all 108 combinations against real Postgres).
