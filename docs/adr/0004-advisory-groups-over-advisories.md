# 0004: Advisory groups sit on top of advisories

- Status: Proposed
- Date: 2026-10-08
- Related: [SENTRA-12 spec](../features/SENTRA-12-dedupe-correlate-sources/spec.md), [ADR 0003](0003-findings-as-derived-state-reconciled-per-project.md)

## Context

Providers describe one issue under several ids (GHSA, PYSEC, CVE). SENTRA-11 keeps one row per `(source, source_id)` and stores `aliases` unresolved; SENTRA-13 makes one finding per advisory row, so one issue shows as several findings. The story requires consolidation without losing provenance and without merging ambiguous records.

## Decision

- **Groups are an additive layer.** `vulnerability_groups` and `vulnerability_group_members` are derived from `vulnerabilities.aliases`. Advisory rows, ids and provenance are never modified, and the correlator and `findings` keep their shape.
- **Rule: connected components over shared identifiers** (an advisory's own id plus its aliases).
- **Ambiguity guard: refuse, do not guess.** A component with more than one CVE id, or whose advisories share no affected `(ecosystem, package)`, is not merged. Members stay singletons, recorded in `group_conflicts` with the reason.
- **Deterministic ids:** group id is a UUIDv5 of the smallest `(source, source_id)` member. A merged-away group keeps its row with `merged_into`.
- **A separate grouper job** (`sentra_grouper`, read-only on advisories) recomputes changed components idempotently from a watermark. A single advisory lock keeps one grouper running.

## Alternatives considered

- Rekey findings to the group: one finding per issue by construction, but reworks the SENTRA-13 key and reconcile logic.
- Merge advisory rows: loses provenance and fights the `(source, source_id)` replay model.
- Group inline in the normalizer: no lag, but couples two concerns and complicates replay.
- Compute groups at read time: no job, but cost per query and no stable group id or conflict record.

## Consequences

- Readers must collapse findings by group (SENTRA-12 read-model PR); until then findings are unchanged.
- A CVE-less advisory pair with no shared identifier is never grouped. A bad alias leaves true duplicates visible rather than merging wrongly.
- A group's id changes when a merge or split changes its smallest member; use `merged_into` to resolve old ids.
- **Revisit triggers:** conflicts are common enough to need the split-by-CVE rule, a source with unreliable aliases is added, or an alias shared by very many advisories makes component loading slow.
