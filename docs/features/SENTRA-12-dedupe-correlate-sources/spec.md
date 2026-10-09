# SENTRA-12: Consolidate overlapping vulnerability advisories

- Status: Draft
- YouTrack: http://localhost:8080/issue/SENTRA-12
- Owner: Data pipeline

## Problem and outcome

- OSV data mixes GHSA, PYSEC and CVE-aliased advisories. SENTRA-11 stores each as its own `vulnerabilities` row and keeps `aliases` unresolved; SENTRA-13 emits one finding per advisory (ADR 0003). One real issue therefore appears as several findings.
- Done when a project's findings list shows one item per underlying issue, with every source advisory still visible, and the grouping is deterministic, replayable and refuses to merge ambiguous records.

## Scope

- In scope: grouper job (alias connected components + ambiguity guard), group tables, conflict recording, findings list read model with nested `sources[]`, bench task, docs of strategy and limitations.
- Out of scope: new source adapters (KEV, GHSA), severity merging/scoring (SENTRA-14), malware-vs-vulnerability distinction for `MAL-`, rekeying or changing `findings`, UI work.
- Dependencies: SENTRA-11 (normalized advisories), SENTRA-13 (findings, correlator, findings API).

## Decisions and alternatives

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Layer | Additive group table over advisories; findings stay per advisory | Rekey findings to group; merge advisory rows | Keeps SENTRA-11 replay model and SENTRA-13 correlator untouched and provenance trivially intact. Cost: collapse at read time. |
| Match rule | Alias connected components (own ID + aliases as undirected edges) | Shared CVE only; alias + package overlap | Catches GHSA/PYSEC pairs without a CVE. Risk of chaining via bad alias, mitigated by the guard. |
| Ambiguity | Suspicious component is not merged: members stay singleton groups, row in `group_conflicts` with reason | Split by CVE; merge with low-confidence flag | Safe, auditable, resolvable on replay when the rule improves. Cost: some true duplicates remain visible. |
| Trigger | Separate grouper job, watermark on `vulnerabilities.updated_at`, own DB role | Inline in normalizer; read-time view | Decoupled, idempotent, mirrors `correlate/`. Cost: short lag. |
| Read model | One item per (project, purl, group), nested `sources[]` | `groupId` field only; `?consolidate` flag | Removes duplicates for every client. Response shape changes (needs contract note). |
| `MAL-` | No special case; no-alias records become singleton groups | Exclude; separate rule | Simplest. Volume to be measured. |
| Group id | UUIDv5 of smallest `(source, source_id)` in component; `merged_into` pointer | Random persisted id; CVE-derived id | Rebuild from data gives identical ids. Id changes on merge/split, pointer keeps old ids resolvable. |

Guard (initial definition, to be validated on real data): a component is **ambiguous** if its members' affected `(ecosystem, package)` sets do not all intersect a common package, or it contains more than one distinct CVE id. **Assumed**; validate by running the grouper on the real npm + PyPI OSV dumps and inspecting every conflict.

Third-party claims:
- OSV `aliases` are symmetric and transitive. **Assumed**; validate by measuring asymmetric edges in the real data.
- 47 GHSA records appear identically in both ecosystem dumps. **Verified** in SENTRA-11 spec.

## Architecture and contracts

- Components: `services/pipeline/src/pipeline/group/` (new), `apps/api` findings read model, migration `011_vulnerability_groups.sql`.
- Flow: normalizer upserts advisories (bumps `updated_at`) -> grouper reads changed advisories by watermark -> recomputes affected components -> writes groups/members/conflicts in one transaction per batch (a component is never split across batches) -> findings API joins findings -> members -> groups and collapses.
- Storage (additive): `vulnerability_groups(id, merged_into, canonical_source, canonical_source_id, created_at, updated_at)`, `vulnerability_group_members(vulnerability_id PK, group_id)`, `group_conflicts(vulnerability_id, reason, detected_at)`, `group_runs`, `group_state`. Final shapes are in migration 011.
- API: findings list item = `{ vulnerability: {groupId, canonical summary, severity}, sources: [{source, sourceId, aliases}] }`. Old fields documented as replaced in `packages/contracts`.
- Compatibility: `vulnerabilities` and `findings` unchanged. Advisory with no group yet falls back to its own row (LEFT JOIN), so lag never hides a finding. No findings backfill.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | Same as findings list today | Assumed | Bench the collapsed query on the SENTRA-13 dataset |
| Concurrent jobs | One grouper instance, lock per run | Assumed | Concurrency integration test |
| Data size and growth | One group row per advisory at most; `MAL-` dominates | Measured from SENTRA-11 spec ratios | Count groups after a real rebuild |
| Latency or throughput | Incremental run touches only changed components, finishes within one poll interval; lag behind normalization is minutes | **Unknown/Assumed** | Manual timing on real OSV data (no bench task yet); record results here |
| Availability and recovery | Grouper down = stale groups, no data loss; full rebuild from `vulnerabilities` is the recovery path | Design property | Rebuild test gives identical ids |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| GHSA + PYSEC + CVE alias | One group, three members | Integration |
| Advisory with no aliases (`MAL-`) | Singleton group | Unit |
| Alias to an advisory we do not hold | Edge ignored until that advisory exists | Unit |
| Bad alias bridges two packages | No merge, conflict row with reason | Integration |
| Late advisory bridges two groups | Groups merge, smaller-key id survives, old id has `merged_into` | Integration |
| Alias removed / advisory withdrawn | Component recomputed, may split; withdrawn advisories keep membership, excluded from findings by existing filter | Integration |
| Duplicate/redelivered runs, replay | Identical result and ids | Integration |
| Grouper crashes mid-run | Per-batch transaction, watermark advances only after commit, rerun is safe | Integration |
| Tenant boundary | Groups are global data; findings query still filters by tenant | Extend tenant isolation test with nested sources |

## Security, observability, and rollout

- Authorization: grouper uses a dedicated role with only the grants it needs; no tenant data in group tables. API authorization unchanged.
- Observability: `group_runs` (advisories seen, groups created/merged/split, conflicts, lag), structured logs per run, conflicts queryable.
- Rollout: migration then first run builds all groups from existing advisories; read model falls back to per-advisory rows until grouped. Rollback: ignore group tables, old findings still intact. Owner: pipeline.

## Acceptance criteria

- [ ] Advisories sharing aliases (e.g. GHSA + PYSEC + CVE) are linked into one group.
- [ ] Every source advisory remains stored and visible under its group; no provenance dropped.
- [ ] Re-running or rebuilding yields identical groups and ids regardless of input order.
- [ ] Ambiguous components are not merged and are recorded with a reason.
- [ ] A later advisory can join or bridge an existing group.
- [ ] Findings list shows one item per issue with nested `sources[]`; ungrouped advisories still appear.
- [ ] Matching strategy, guard and known limitations documented (ADR + learning note).

## Verification

- Manual: run grouper on real OSV data, inspect conflicts, compare finding counts before/after for a sample project.
- Automated: unit (components, guard, id determinism, order independence), integration (scenarios above, role grants, replay), API integration (collapse, fallback, tenant isolation).
- Bench: not built yet; time a full rebuild and an incremental pass on real OSV data and record it here.
- `task pipeline:test`, `task pipeline:test:integration`, `task fallow`.

## Open questions and assumptions to validate

- Guard definition and alias symmetry on real data (before merge of grouper PR).
- Group severity shown as highest advisory severity as-is; real merge deferred to SENTRA-14 (confirm with user).
- Canonical summary choice (which member supplies it): proposal is smallest-key member, confirm.
- Stacked PRs: (1) schema + grouper, (2) API read model.
