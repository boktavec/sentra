# SENTRA-13: Matching dependencies to vulnerabilities

Spec: [docs/features/SENTRA-13-match-dependencies/spec.md](../features/SENTRA-13-match-dependencies/spec.md). Decision record: [ADR 0003](../adr/0003-findings-as-derived-state-reconciled-per-project.md).

## What was built

A third pipeline process, the correlator, that turns "this project has these dependencies" and "these advisories exist" into **findings**. Three things wake it: an SBOM finished parsing (`sbom.parsed`), advisories changed (`vulnerabilities.normalized`), or a daily sweep. All three call one function, `reconcile(project)`, which recomputes the project's findings from its newest parsed import and the current advisories, writes only what changed, and resolves what is no longer true. The API gained one read route, `GET /v1/orgs/:orgId/projects/:slug/findings`.

On the real PyPI and npm dumps (256,310 advisories) with 1,000 synthetic projects of about 1,500 dependencies: one project reconciles in about 0.06 s, a re-run in 0.01 s with no writes, the first full load in 58 s, and a full sweep in 35 s.

## Why it is designed this way

- **Findings are derived state.** Everything in a finding can be recomputed, so there is nothing precious to protect and no migration story beyond "run the sweep". That one fact removes most of the usual correctness worries about event ordering.
- **Recompute the whole project, under a lock.** Forward (new SBOM) and reverse (new advisory) triggers can hit the same project at once, and events arrive at least once. If each computed a delta, one could resolve a finding the other just created. Taking a Postgres advisory lock per project and recomputing from current state means the answer does not depend on who ran first. The price is doing O(project) work per trigger, which measured fine.
- **Events are wake-ups, the database is the truth.** `sbom.parsed` names an import; the matcher reads tenant and project from the `sbom_imports` row. `vulnerabilities.normalized` carries counts only, so "what changed" is a query over `updated_at` against a watermark. A lost event costs latency, and the sweep is the same code with every project selected.
- **One comparable name, defined once.** The dependency stores purl `namespace` and `name` separately while OSV stores one combined name (`@angular/core`, `group:artifact`). A SQL function builds a normalized `match_name` as a generated column on both tables, so the join is an indexed equality and the rule lives in one place. Without it, scoped npm, Maven and Go packages would never have matched.
- **Natural keys, not row IDs.** Reprocessing an SBOM deletes and re-inserts its dependency rows, and rewriting an advisory does the same to its affected rows. A finding keyed `(project, purl, vulnerability)` with a stored evidence snapshot survives both.
- **Uncertainty is a first-class result.** A version that does not parse, a range that cannot be evaluated, or an advisory entry with no version data becomes an `unverifiable` finding with a reason, not a guess and not silence. Real data shows how rare that is: 14 of about 263,000 advisory entries have no version data.

## Alternatives considered

A finding per import (history for free, but findings multiply per upload and the reverse scan must cover every import); targeted per-advisory updates for the reverse path (cheaper per event, but a second code path that drifts and is only healed by the sweep); events carrying changed advisory IDs (contradicts ADR 0002 and loses the information with the event); normalizing names in Python (no index use); version comparison in SQL (hard to test, wrong at the edges); grouping duplicate advisories now (SENTRA-12 owns that strategy); user triage states and audit events (not needed by the acceptance criteria).

## Tradeoffs

- One real issue can appear as two findings (a GHSA and a PYSEC advisory) until SENTRA-12 consolidates advisories.
- npm names match case-insensitively while OSV matches exactly: a legacy upper-case advisory name produces a finding OSV would not. Chosen because purl normalization lowercases npm names, so the alternative is a missed finding.
- Leading-zero versions such as `2026.03.28` are `unverifiable` where OSV's lenient npm parser orders them. Surfacing it beats guessing.
- A popular advisory reconciles every project that uses the package (41 of 1,000 in the benchmark, 2.5 s). Fine at lab scale, the first thing to revisit at 10x.
- The sweep lives inside the worker until SENTRA-10 provides a scheduler.

## Scaling implications

Per project the cost is one set-based join (about D index probes plus the candidate rows), a decision per candidate in Python, and batched writes. Cost follows the number of candidate rows and findings, not the number of dependencies: a dense stress project with about 90,000 candidates and 22,000 findings took 5 s at first and 1.9 s after tuning, while a typical one takes 0.06 s. Reverse work grows with the number of projects touched by a changed advisory, not with all projects, because it starts from the changed advisories' package names. Running more correlators is safe (leases and per-project locks) but untested beyond threads. A linear extrapolation (not measured) puts a sweep at about 6 minutes for 10x the projects and about an hour at 100x; the next steps would be partitioning projects across workers, then a targeted reverse path.

**What the tuning taught.** I assumed the writes were slow and batched them: only 1.6x. Profiling a heavy project then showed the time was in version matching, which re-parsed the same strings millions of times (`packaging.Version` constructed about 4 million times for one project). Caching parsed versions gave another 1.8x. Measure the cost before choosing what to optimize, and re-measure on the same data after each change.

## Failure and security considerations

- The matcher writes a tenant table, the widest grant in the pipeline, so `org_id` and `project_id` are always copied from the dependency row and never from an event. A test sends an event carrying other tenants' IDs and checks nothing lands there.
- The correlator role can read dependencies and advisories and write only its own three tables. A test pins that it cannot write dependencies or read memberships.
- The API route repeats the org filter next to the project lookup, answers with the same 404 for another tenant's org or project as for a missing one, and is covered in the SENTRA-21 suite (outsider, dual membership, random IDs), with a positive control so a broken route cannot pass as "isolated".
- A crash mid-sweep or mid-watermark repeats some reconciles, which are no-ops. The watermark looks back 5 minutes because the normalizer stamps `updated_at` with the transaction start time, so a slow batch can commit after a later one was seen.

## Key concepts to understand

- **Derived state and reconciliation**: compare "what should exist" with "what exists" and write the difference, instead of replaying events.
- **At-least-once delivery and idempotency**: why duplicate and reordered events are harmless when handlers recompute.
- **Advisory locks**: a cheap, database-native lock keyed by an arbitrary value, released with the transaction.
- **Watermarks and their race**: a "since" marker based on a timestamp that is set at transaction start can miss rows that commit late; overlap or a sequence fixes it.
- **OSV range semantics**: sort events, `introduced` turns "affected" on, `fixed` and `last_affected` turn it off; comparison uses the ecosystem's own ordering (PEP 440, semver).
- **Generated columns**: a stored column computed by an immutable function, giving an indexable normalized key with automatic backfill.
- **Profile before optimizing**: the first guess (database writes) was only part of the cost; a profiler found the real hotspot in a few minutes.
- **Keyset pagination**: paging by `(timestamp, id)` so rows added between pages cannot cause skips or repeats.
