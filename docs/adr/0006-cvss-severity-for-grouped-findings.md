# 0006: Store CVSS on advisories and select severity for grouped findings

- Status: Accepted for SENTRA-15
- Date: 2026-10-08
- Related: [SENTRA-15 spec](../features/SENTRA-15-findings-list/spec.md), [ADR 0005](0005-advisory-groups-over-advisories.md)

## Context

OSV stores CVSS vectors, not base scores. SENTRA-12 shows one item per dependency and vulnerability group, and an item's canonical advisory may have no vector while another source does. The findings list must sort 25,000 project findings by standard severity without calculating every vector on every request. Sentra risk priority, which may use KEV and tenant exposure, belongs to SENTRA-14.

## Decision

- Calculate standard CVSS base scores during advisory normalization. Store nullable score, version, and calculation timestamp on each global `vulnerabilities` row, while retaining the source vectors. A bounded, idempotent backfill fills existing rows.
- Prefer a valid v4 vector, then v3.1, then v3.0 within one advisory. Invalid or missing vectors yield an unavailable score; they never remove a finding.
- For a grouped list item, use the highest valid score among its advisory members and include the scoring advisory as provenance. Unscored groups sort last. This is a severity display rule, not a Sentra risk score.
- Read KEV status from active `kev_entries` and a completed catalog snapshot. A historical `cisa-kev` advisory stub is not proof of current KEV listing.

## Alternatives considered

- Score every vector in the list request: avoids stored derived data, but makes sorting before pagination expensive and unpredictable.
- Copy scores onto each tenant finding: enables a direct project index, but duplicates global facts and requires every affected finding to be refreshed when an advisory changes.
- Use only the canonical advisory's score: simpler query, but can show a grouped issue as unscored when another member has a valid CVSS assessment.
- Treat source presence as KEV status: wrong after a catalog entry is removed, because the stub row remains for provenance.

## Consequences

- A severity update is visible as soon as normalization commits; it does not depend on the correlator rewriting tenant findings. Group membership changes can alter displayed severity and cursor order.
- The grouped query looks up members' scores before pagination. A synthetic 25,000-finding project met the local first-page target; monitor real group sizes and query latency before considering denormalization.
- The CVSS library is pinned and requires source-vector validation. Raw vectors remain available to reprocess when scoring rules or library versions change.
- Risk priority can be added later without changing finding identity or overwriting CVSS fields.
