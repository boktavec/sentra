# 0008: Read-time, rule-based risk priority

- Status: Accepted for SENTRA-14
- Date: 2026-10-09
- Related: [SENTRA-14 spec](../features/SENTRA-14-risk-priority/spec.md), [ADR 0004](0004-kev-as-enrichment-plus-linked-vulnerability-rows.md), [ADR 0006](0006-cvss-severity-for-grouped-findings.md)

## Context

The findings list orders by CVSS only. CVSS does not say whether attackers use a vulnerability (CISA KEV) or whether the vulnerable package ships (dependency scope). Priority inputs (group CVSS, KEV status) change outside the correlator: KEV ingestion does not wake it (ADR 0004), and advisory scores change when normalization commits (ADR 0006).

## Decision

- Priority is a tier P1 to P4 chosen by ordered rules over group CVSS, KEV status, lead scope and match quality. KEV listing sets P1; otherwise CVSS high, medium or low sets P2, P3 or P4 (unscored is P3); optional or excluded scope lowers the tier by one, never below P4. Unverifiable matches and unavailable KEV data are reported as factors and do not change the tier.
- The tier is computed at read time in the shared finding SQL (`finding-sql.ts`), which both the list and the detail use. SQL is the single source of truth; the web only maps returned codes to labels.
- The model carries a version (`PRIORITY_MODEL_VERSION`, returned as `modelVersion`). Any rule, threshold or input change bumps it and updates the docs and matrix tests.
- Nothing is stored: finding identity and data are untouched.

## Alternatives considered

- Additive 0-100 score: more granular, but false precision and harder to explain; can be added later.
- Store the tier on `findings` from the correlator: sorts from an index, but goes stale when KEV or CVSS change and needs new wake-ups and backfills.
- Derived table and job: same staleness plus a new moving part.

## Consequences

- Tier and order are always current with KEV, CVSS and grouping, with no backfill on a model change.
- Sorting and filtering by tier require KEV status for every item of the project before paging, so the query does more work per request. Validated by the SENTRA-15 benchmark on a representative corpus (25,000 findings, 105,000 advisories, 1,000 KEV entries): first-page p95 321 ms, recorded in the spec. The group-advisory lookup must stay index-friendly (`IN` over a `UNION ALL`, not `OR`); an `OR` form scans `vulnerabilities` per item and took seconds to minutes.
- There is no tier history, so a tier can change between reads. Per-tenant tuning, EPSS and exposure data are out of scope for v1.
- If the read-time cost becomes a bottleneck, denormalization needs its own decision.
