# 0003: Findings are derived state, reconciled per project

- Status: Proposed
- Date: 2026-10-08
- Related: [SENTRA-13 spec](../features/SENTRA-13-match-dependencies/spec.md), [ADR 0002](0002-event-conventions-for-async-ingestion.md)

## Context

SENTRA-13 joins tenant dependencies with global vulnerabilities. Both sides change independently (a new SBOM, a new advisory), events are delivered at least once, and the rows both sides point at (`sbom_dependencies`, `vulnerability_affected`) are deleted and re-inserted on reprocessing. Several workers may act on one project at once.

## Decision

- **Findings are derived state.** They can always be recomputed from the latest parsed import and the current advisories. Nothing user-authored lives in them, so they carry no audit trail of their own.
- **One reconcile function per project.** `reconcile(project)` takes a Postgres advisory lock on the project, recomputes the full desired set inside its transaction, upserts only rows that changed and resolves the rest. Every trigger calls it, so results do not depend on event order.
- **Events are wake-ups; the database is the truth.** `sbom.parsed` names an import, `vulnerabilities.normalized` means "something changed". Progress lives in `match_runs` and a watermark over `vulnerabilities.updated_at`. A scheduled sweep reconciles every project, which heals any lost event.
- **Findings use natural keys.** `(project_id, purl, vulnerability_id)` plus a stored evidence snapshot. No foreign keys to rows that get rebuilt.
- **Comparable package names are computed once.** `package_match_name()` is a SQL function stored as generated columns on both tables, so one rule serves every query.
- **The matcher is its own least-privilege role** (`sentra_correlator`). It is the first pipeline process that writes a tenant table, so `org_id` and `project_id` are always copied from the dependency row, never from an event.

## Alternatives considered

- Finding per import: exact history, but findings multiply per upload and the reverse scan must cover every import.
- Targeted (per advisory) reverse updates: cheaper per event, but a second code path that drifts and is only healed by the sweep.
- Fat events carrying advisory IDs: contradicts ADR 0002 and loses information when an event is lost.
- Normalizing names in Python: no migration, but candidate selection can no longer use an index.

## Consequences

- A popular advisory triggers a whole-project reconcile in every project that uses the package. That is O(projects affected × dependencies). Fine at lab scale; revisit if measured too slow.
- One real issue may appear as several findings until SENTRA-12 consolidates advisories.
- The matcher's grants are wider than any existing pipeline role; a test pins them.
- **Revisit triggers:** reconcile time per project or full sweep time exceeds what a lost event may cost (add targeted reverse updates), a tenant needs history (add an append-only change log), or SENTRA-10 provides a scheduler (move the sweep out of the worker).
