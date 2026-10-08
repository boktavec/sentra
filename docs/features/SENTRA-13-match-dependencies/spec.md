# SENTRA-13: Match dependencies to vulnerabilities

- Status: Approved (implemented; see Implementation notes)
- YouTrack: http://localhost:8080/issue/SENTRA-13 ("[MVP] Match Dependencies to Vulnerabilities")
- Owner: Sentra operator / project owner

## Problem and outcome

- A project member has uploaded an SBOM (SENTRA-5, parsed by SENTRA-6) and Sentra holds normalized vulnerabilities (SENTRA-11), but nothing connects the two. This story produces the `findings` that risk scoring (SENTRA-14), the findings UI (SENTRA-15/16) and the AI investigation stories (SENTRA-17 to 19) build on.
- Done means: when an SBOM is parsed, or advisories change, Sentra reconciles each affected project's findings against that project's latest import. Every finding says which dependency matched which advisory, by what rule, and how sure we are. Versions we cannot judge are surfaced as `unverifiable`, never guessed. Re-running changes nothing. A tenant can only read its own findings, through one minimal read route.

## Scope

- In scope:
  - Matcher worker in `services/pipeline` (new `correlate` package, own DB role `sentra_correlator`).
  - `findings`, `match_runs` and a watermark table; `match_name` generated columns and function on `sbom_dependencies` and `vulnerability_affected`.
  - Version comparison (PEP 440 via `packaging`; semver ordering) and OSV range evaluation.
  - New event `sbom.parsed.v1`, published by the SBOM parse worker after its commit; the matcher also consumes `vulnerabilities.normalized`.
  - Scheduled sweep (worker-internal interval loop) and an operator task.
  - `GET /v1/orgs/:orgId/projects/:slug/findings` (read-only, paginated) with SENTRA-21 isolation cases.
  - Metrics, structured logs, learning note, ADR 0003.
- Out of scope (documented, not built):
  - Cross-source dedup (SENTRA-12). One finding per advisory row; the same real issue can show as two findings until SENTRA-12 lands. **Known limitation.**
  - Risk score, KEV weighting (SENTRA-14); list sorting, filters, UI (SENTRA-15); detail (SENTRA-16).
  - User triage states, audit events (SENTRA-20), alerting (SENTRA-23), scheduler (SENTRA-10), SLOs (SENTRA-26).
  - Ecosystems with no advisories yet (only npm and PyPI have an adapter). Dependencies with a NULL ecosystem are counted, not matched.
  - A `finding.updated` event, and targeted (non-whole-project) reverse reconciliation.
- Dependencies and related stories: depends on SENTRA-6 and SENTRA-11 (both Done). Feeds SENTRA-14 to 19. SENTRA-12 will consolidate on top of findings.

## Decisions and alternatives

Claims about third-party behavior are labeled **Verified** (how) or **Assumed** (how it will be validated).

| # | Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- | --- |
| 1 | Triggers | SBOM parsed, new advisories, and a scheduled full sweep, all through one match function | SBOM parsed only; no sweep | Without the reverse trigger a user is never told a new CVE affects them. The sweep heals lost events. Cost: a reverse path and a sweep to build and operate. |
| 2 | Current state | A finding belongs to the project; "current" is the project's newest `parsed` import. Reconcile marks no-longer-true findings `resolved` | Finding per import; snapshot plus history table | Bounded reverse-scan cost and natural idempotence. Cost: no per-import history; `first_seen_at`/`resolved_at` cover most of it. |
| 3 | Statuses | System-managed `open` / `resolved` with `resolved_reason`; withdrawn advisories resolve their findings (`advisory_withdrawn`) | User triage states; reserved nullable column | No write routes or audit surface now. Triage is an additive later story. |
| 4 | Uncertainty | `match_quality` = `confirmed` or `unverifiable`, plus `match_reason` and evidence. NULL-ecosystem dependencies get no finding, only a per-import count | Separate `match_gaps` table; counters only | Uncertainty sits where users and the AI already look. Risk: noise from `unverifiable`; measure on real data (see assumptions). |
| 5 | Where it runs | Python worker in `services/pipeline`; candidates selected in SQL, version decided in Python | TypeScript worker; matching in SQL functions | Reference PEP 440 implementation exists in Python; workers already live here. Cost: first pipeline role that writes a tenant table. Mitigation: `org_id` and `project_id` are copied from the dependency row, never from an event. New dependency `packaging` (PEP 440 ordering is subtle; the PyPA library is the reference). |
| 6 | Name matching | `match_name(ecosystem, namespace, name)` SQL function, stored as generated columns on both tables, indexed on `(ecosystem, match_name)` | Normalize in Python at match time; fix in parser and adapter | See "Verified facts". One definition, indexed joins, automatic backfill. Cost: one migration rewriting two tables. |
| 7 | Overlapping advisories | One finding per advisory row, keyed to `vulnerabilities.id` | Alias grouping here; block on SENTRA-12 | Keeps SENTRA-12 free to choose its strategy. Aliases already live on `vulnerabilities`. |
| 8 | Scope | All scopes match; `scope` stored on the finding and refreshed on reconcile | Skip `excluded`; `required` only | Nothing silently dropped; SENTRA-14 and 15 can weigh or filter. |
| 9 | Triggers to matcher | Events are wake-ups; database state is the truth (`match_runs` per import, watermark over `vulnerabilities.updated_at`) | Fat events with IDs; DB polling only | ADR 0002: events carry references, not payloads. A lost or duplicate event costs only latency. |
| 10 | Reconcile | `reconcile(project)`: advisory lock per project, recompute the full desired set in the transaction, upsert changed rows, resolve the rest; one transaction per project | Targeted delta for reverse; partition by project on the broker | One code path, order-independent. Cost O(projects affected × deps) per reverse run; revisit only if measured too slow. |
| 11 | Identity and evidence | Key `(project_id, purl, vulnerability_id)` plus `evidence` jsonb snapshot | FKs to dependency and affected rows; full snapshots | **Verified:** `sbom_dependencies` rows are deleted and re-inserted on reprocess (`services/pipeline/src/pipeline/imports.py:70`) and `vulnerability_affected` rows likewise (`normalize/store.py:186`), so row IDs are not stable. |
| 12 | API | One minimal read route; SENTRA-15 and 16 extend it | No route; list and detail now | Gives an end-to-end isolation test and a manual-test path without UI scope. |
| 13 | Sweep | Interval loop in the worker (assumed 24h), lease-guarded, plus an operator task | Operator task only; wait for SENTRA-10 | Gives the safety net now. Move to a scheduler under SENTRA-10. |
| 14 | Audit | None in this story | Per-change or per-run audit events | Findings are derived data, recomputable. SENTRA-20 decides if system changes belong in the audit log. |

### Verified facts

- **Verified (2026-10-08, ran `packageurl-python` from the pipeline env):**
  - `pkg:pypi/Django_Rest.Framework@1.0` gives name `django-rest.framework`. It lowercases and turns `_` into `-`, but keeps `.`. PEP 503 also collapses `.`, so the parser output is not fully normalized.
  - `pkg:npm/%40Angular/Core@1` gives namespace `@Angular` (case kept) and name `core`.
  - Maven and Go give namespace and name separately with case kept (`org.apache` + `Log4j-core`; `github.com/Foo` + `bar`).
- **Verified (code):** `sbom_dependencies_match_idx` is on `(ecosystem, name)`, where `name` excludes the namespace. OSV's `package_name` is combined (`@angular/core`, `group:artifact`, `github.com/foo/bar`), so scoped npm, Maven and Go would never match on it.
- **Verified (code and SENTRA-11 spec):** dropped `GIT` ranges are not stored; `versions[]` and ranges are both kept; 5,529 PyPI `affected` entries have no ranges and 7,213 have no versions.

### Matching rules (Assumed until checked against OSV's spec and real data)

- Candidate selection: dependency and `vulnerability_affected` rows join on equal `(ecosystem, match_name)`; withdrawn advisories (`withdrawn_at` set) are excluded.
- An affected entry matches a version when it is in `versions[]`, or when any range in the entry contains it. An entry may use both; the result is the union.
- Range evaluation (OSV algorithm): sort events by version using the comparator, with `introduced: 0` as the lowest. Walk them: `introduced` sets affected if `v >= event`; `fixed` clears it if `v >= event`; `last_affected` clears it if `v > event`. The state at the end is the result.
- Comparator: `ECOSYSTEM` ranges use the ecosystem's order (PyPI: PEP 440; npm: semver). `SEMVER` ranges use semver for any ecosystem. Versions in `versions[]` compare as equal after the ecosystem's normalization.
- `unverifiable` reasons (`match_reason`): `version_unparseable` (dependency version does not parse under the needed comparator), `no_version_data` (matching entry has neither versions nor usable ranges), `range_malformed` (events that cannot be evaluated), `ecosystem_unsupported` (no comparator). Everything else that matches is `confirmed`; everything that does not match produces no finding.
- When several affected entries of one advisory match the same dependency, one finding is kept; `confirmed` beats `unverifiable`, and `evidence` records the deciding entry.
- Validation: unit tests drawn from real PyPI and npm advisories, and a one-off comparison with `api.osv.dev` (below).

### Verified against real data (2026-10-08, PR 2)

- **Verified (agreement with OSV):** 629 package/version cases (60 random PyPI and 60 random npm packages with at least 3 advisories, versions taken from their range boundaries and listed versions) were checked against `api.osv.dev/v1/querybatch` using the current PyPI and npm `all.zip` dumps. Our confirmed set matched OSV's exactly in 624 cases. The 5 differences all involve one package, `openclaw`, and show two deliberate behaviors:
  - An advisory names the package `Openclaw` (capital O). We compare npm names case-insensitively (purl normalization lowercases npm names, so a legacy upper-case package cannot be told apart); OSV compares exactly. We report a finding where OSV does not. Accepted: a missed finding is worse than a rare extra one.
  - Another advisory's `ECOSYSTEM` range ends at `fixed: 2026.03.28`, which is not valid semver (leading zero). OSV's lenient npm parser orders it; we mark the range `range_malformed` and the finding `unverifiable` instead of guessing. Four of the five differences are this case (we surface it, OSV confirms it).
- **Verified (noise):** advisory entries with neither versions nor usable ranges: 13 of 31,145 PyPI entries and 1 of 232,647 npm entries (no `MAL-` ones). `no_version_data` findings are therefore negligible and need no cap.

## Architecture and contracts

- Components: `services/pipeline` (new `correlate` package: worker, matcher, versions, store, sweep; parse worker gains a publisher), `apps/api` (migrations, findings route, isolation cases), `packages/contracts` (new event, model doc).
- Flow:

```text
sbom parsed (commit)  --publish-->  sbom.parsed.v1 ------------------+
vulnerabilities.normalized (existing) ------------------------------+|
sweep timer (lease) ------------------------------------------------+||
                                                                     vvv
 correlate worker: wake-up -> pick projects
   sbom.parsed                 -> that import's project
   vulnerabilities.normalized  -> advisories with updated_at > watermark
                                  -> distinct projects whose latest import has a matching match_name
   sweep                       -> every project (batched)
 for each project, one transaction:
   advisory lock(project) -> latest parsed import
   desired set = SQL candidates -> Python version decision -> {finding, quality, evidence}
   upsert desired (only if changed); resolve the rest; record match_runs
 advance watermark after the batch is committed
```

- Storage (new migration; all tenant tables carry `org_id` and `project_id`):
  - `findings`: `id`, `org_id`, `project_id`, `vulnerability_id` FK, `purl`, `version`, `ecosystem`, `scope`, `import_id`, `match_quality`, `match_reason`, `status` (`open`/`resolved`), `resolved_reason`, `first_seen_at`, `last_seen_at`, `resolved_at`, `matcher_version`, `evidence` jsonb, timestamps. `UNIQUE (project_id, purl, vulnerability_id)`. Indexes on `(project_id, status, first_seen_at DESC, id)` and `(vulnerability_id)`.
  - `match_runs`: one row per `(import_id, matcher_version)` with counts, status, `claimed_until` lease.
  - `correlation_state`: watermark and sweep lease.
  - `match_name(ecosystem, namespace, name)` (IMMUTABLE) and generated stored `match_name` columns on `sbom_dependencies` and `vulnerability_affected`, indexed on `(ecosystem, match_name)`. Index `sbom_imports (project_id, status, created_at DESC)` for "latest parsed import".
  - Role `sentra_correlator` (NOLOGIN in the migration, as in migration 009): `SELECT` on the global and dependency tables and `sbom_imports`, `INSERT/UPDATE` on `findings`, `match_runs`, `correlation_state`. No access to anything else.
- Events:
  - New `sbom.parsed.v1`: ADR 0002 envelope plus `importId`, `orgId`, `projectId`, `dependencyCount`. The matcher reads `org_id` and `project_id` from the database, not the event.
  - Published by the parse worker after its commit; a crash before publish is recovered by redelivery of `sbom.uploaded`, as in SENTRA-11.
  - Existing `vulnerabilities.normalized` is only a wake-up; its counts are ignored.
- API: `GET /v1/orgs/:orgId/projects/:slug/findings?limit&cursor` (projects are addressed by slug, like the SBOM routes). Any org member. Keyset pagination on `(first_seen_at DESC, id)`. Returns finding fields plus `vulnerability {source, sourceId, aliases, summary, severity}`. Both open and resolved findings appear, with `status`; SENTRA-15 adds filters. Uses the existing org and project scoping, and the error shape in `packages/contracts/error-response.md`.
- Compatibility: additive. The `match_name` generated columns rewrite two tables once. Rollback: stop the worker and drop the new tables; the columns are harmless.

## Workload and targets

Design target (agreed 2026-10-08): lab scale. All numbers below are **Assumed** and are validated by measuring on synthetic data.

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Tenants and projects | About 100 tenants, 1,000 projects | **Assumed** design target | Synthetic data generator |
| Dependencies per SBOM | 500 to 2,000 typical; parser cap is the ceiling | **Assumed**; parser cap from SENTRA-6 | Synthetic SBOMs, plus a real one |
| Advisories | About 256k today (npm + PyPI) | **Verified** in SENTRA-11 | Query row counts |
| Import frequency | About 1 per project per day | **Assumed** | Count `sbom.parsed` events |
| Advisory batches | A few per day | **Assumed** (follows SENTRA-7) | Count `vulnerabilities.normalized` |
| Forward match (one import) | Cost about O(D · (log A + k · r)); one set-based candidate query, not D queries. **Measured:** about 0.06 s per 1,500-dependency project; a re-run takes 0.01 s and writes nothing | Analysis, then measured (see below) | `task pipeline:correlate:bench` |
| Reverse match, first full load | Whole-project reconcile for up to all 1,000 projects. **Measured:** 58 s (about 0.06 s per project); one changed advisory touched 41 of 1,000 projects and took 2.5 s | Worst case under the target, then measured | `task pipeline:correlate:bench` |
| Idempotent re-run | Zero rows written when nothing changed | Design rule | Integration test compares rows and `updated_at` |
| Latency (upload to findings; advisory to findings) | **Unknown** | Not invented; SENTRA-26 sets SLOs | Record measured values in the PR |
| Availability and recovery | **Unknown**; recovery is redelivery plus the sweep | Not invented | Crash-injection tests |
| Sweep interval | 24h. A full sweep of 1,000 projects **measured** 35 s, so the interval is limited by staleness tolerance, not cost | **Assumed**; bounds how long a lost event leaves findings stale | Revisit with SENTRA-26 |

### Measured (2026-10-08, final code)

Laptop, local Postgres, one process. `task pipeline:correlate:bench` loads the real PyPI and npm OSV dumps into a scratch database (256,310 advisories, 264,992 affected entries) and adds 100 synthetic orgs and 1,000 projects with about 1,500 dependencies each (1,496,828 rows). About 10% of each project's dependencies are packages that have advisories, chosen uniformly by package, at a version taken from one of that package's range boundaries.

| Step | Result |
| --- | --- |
| Forward match, one project | 0.06 s cold; median 0.061 s over five more |
| Re-run of the same project | 0.01 s; zero rows written (`unchanged` only) |
| First reverse run, no watermark (every project) | 58.2 s, creating 366,010 findings (3,431 `unverifiable`) |
| One advisory changes | touches 41 of 1,000 projects; 2.52 s (0.35 s to find the projects, 2.24 s to reconcile them) |
| Full sweep | 35.1 s with 25 projects per step |

**Stress case** (`--dense`: packages weighted by how many advisories they have, so projects average thousands of findings; 8 projects, 10,000 to 95,000 candidate rows each, up to 22,879 findings). Same data, three versions of the code:

| Code | Total for 8 projects | Heaviest projects (80,000 to 95,000 candidates) |
| --- | --- | --- |
| Original: one insert per round trip, version strings re-parsed per candidate | 23.5 s | 4.8 to 5.7 s each |
| Batched writes (`executemany`) only | 15.0 s | 3.3 to 3.75 s each |
| Batched writes and cached version parsing | 8.4 s | 1.6 to 2.0 s each |

- **What profiling showed.** I first assumed writes dominated and batched them. That gave only 1.6x. Profiling a heavy project then showed the real hotspot was matching: `_same` parsed both version strings for every listed version of every candidate, about 4 million `packaging.Version` constructions for one project. Parsed versions are now cached, and the parsed keys of an entry's listed versions are built once per distinct list. Together the two changes cut the stress case 2.8x and the standard case about 2x (the first full load went from 107 s to 58 s, the sweep from 91 s to 35 s). The earlier 107 s and 91 s figures were measured before the matching fix and are replaced.
- **Not profiled after the fix:** what the remaining 1.6 to 2.0 s of a heavy project is spent on (candidate SQL is about 0.5 s of it).
- **Agreement with OSV re-checked after the change:** 623 of 629 cases; the only difference from the earlier 624 is one advisory OSV published after the dump was downloaded (15:42 against a 14:08 download), so every other verdict is unchanged.
- **The first "one advisory" figure (8 s) was matching time, not the affected-projects query,** which takes 0.35 s.
- The sampled data is synthetic: real SBOMs may be denser or sparser in vulnerable packages. The numbers show the mechanism scales to the lab target, not what production will see.
- Watermark overlap (5 minutes) re-reconciles recently changed advisories' projects once more as a no-op. Right after a bulk load, every advisory is inside the overlap, so the next event re-reconciles every project. The benchmark ages the loaded rows to measure the steady state.
- Latency from event to findings is still **Unknown** as an SLO (SENTRA-26).

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Same event delivered twice, or two workers | Per-project lock plus idempotent upsert: same rows, no extra writes | Integration test; concurrency test |
| Forward and reverse triggers race on one project | Serialized by the lock; each recomputes from current state, so order does not matter | Concurrency test |
| Dependency version unparseable | `unverifiable` / `version_unparseable` when the package matches | Fixture |
| Advisory entry has no versions and no ranges | `unverifiable` / `no_version_data` | Fixture from real data |
| Dependency has NULL ecosystem | No finding; counted per import | Fixture |
| Advisory withdrawn after a finding exists | Finding `resolved`, reason `advisory_withdrawn` | Integration test |
| Advisory rewritten (affected rows rebuilt) | Next reconcile refreshes evidence; no dangling references (keys are natural) | Integration test with reprocess |
| Dependency removed or version changed in the new import | Old finding `resolved` (`dependency_removed` or `version_changed`); reappearance reopens it | Integration test |
| SBOM reprocessed (dependency rows replaced) | Findings unaffected, then reconciled | Integration test |
| Same package, two tenants | Independent findings; each row's `org_id` and `project_id` equal its dependency's | Integration test |
| Postgres or broker unavailable | Retry with backoff; offset left uncommitted if the failure cannot be recorded (SBOM and normalizer pattern) | Stop each dependency |
| Poison event (invalid contract) | Logged and dropped after validation fails; sweep covers any real loss | Contract test |
| Crash after commit, before watermark advance | Reprocessing the same advisories is idempotent | Kill-and-restart test |
| Very popular package, many hits | Reconcile batches writes; unverifiable noise measured, not capped | Metrics, real-data run |
| Cross-tenant read via the route | Same `404` as a missing resource; nothing changes | SENTRA-21 cases |

## Security, observability, and rollout

- Authorization and isolation:
  - Findings carry `org_id` and `project_id`, copied from the dependency row.
  - The matcher role is least-privilege; a test asserts it cannot read tables outside its grants.
  - The route goes through the existing org and project checks. Outsider, dual-membership and random-ID cases are added to the SENTRA-21 suite, replacing the findings part of its todo.
  - Findings contain only package identity, versions and evidence. No SBOM contents are stored beyond what `sbom_dependencies` already holds.
- Logs and metrics:
  - Structured logs per `packages/contracts/logging.md` with `correlationId`, run ID, `project_id` and `org_id`; never package lists.
  - Metrics: findings written, resolved and unchanged; projects reconciled; match quality by reason; dependencies skipped as unmatchable; reconcile duration; lock wait; sweep duration and age; worker errors. Consumer lag from the broker.
  - Alerts are **Unknown** until SENTRA-23.
- Rollout and ownership:
  - Additive migration, new consumer group.
  - The first sweep reconciles every project, which also backfills imports parsed before `sbom.parsed` existed.
  - Operator owns the worker and the sweep until SENTRA-10 and SENTRA-23.

## Delivery plan (stacked PRs)

Each PR is branched off the previous one and independently green. Merge bottom to top.

1. **Foundations:** this spec, ADR 0003, migration (`match_name`, `findings`, `match_runs`, `correlation_state`, role), `sbom.parsed.v1` contract, parse worker publishes it.
2. **Matcher core:** version comparators, OSV range evaluation, `reconcile(project)`, unit and integration tests, real-advisory fixtures.
3. **Worker:** consumers, watermark reverse path, sweep and lease, metrics, operator task, concurrency and crash tests.
4. **API and docs:** findings route, SENTRA-21 cases, learning note, measured numbers filled into this spec.

## Acceptance criteria

- [x] Parsed project dependencies are correlated with normalized vulnerabilities, on SBOM parsed, on advisory changes, and by the sweep.
- [x] Ecosystem, normalized package name and version are all considered, including scoped npm, Maven and Go names.
- [x] Matches produce findings with `org_id` and `project_id` taken from the dependency row.
- [x] Re-running changes nothing (no writes, `updated_at` untouched).
- [x] Each finding records the dependency identity, import, advisory and the rule that matched (`evidence`).
- [x] Unparseable versions, missing version data and unsupported ecosystems are `unverifiable` with a reason, or counted; never guessed.
- [x] Findings resolve (with a reason) when the dependency or advisory no longer applies, and reopen if they come back.
- [x] A tenant cannot read another tenant's findings; cases are in the SENTRA-21 suite.
- [x] Measured forward and full-sweep times on lab-scale synthetic data are recorded here.

## Verification

- Manual:
  - Bring up the stack, create a project, upload an SBOM containing a known-vulnerable PyPI and npm package, then check `GET .../findings` shows `confirmed` findings with evidence.
  - Upload an SBOM with an unparseable version: an `unverifiable` finding appears.
  - Upload a newer SBOM without the package: the finding becomes `resolved`.
  - Run `task pipeline:correlate:sweep` twice: second run writes nothing.
  - Request the same route as a user from another org: same `404` as a random project.
- Automated:
  - Unit: comparators and range evaluation on real advisories; `match_name` cases.
  - Integration: all rows in the edge-case table, the lock and race tests, role privilege test, route and SENTRA-21 cases.
  - Contract: `sbom.parsed.v1` producer and consumer.
- Load: synthetic data for the Q10 target; record plan, timings and findings counts.

## Open questions and assumptions to validate

- ~~OSV range-evaluation algorithm and `versions[]` semantics~~ **Verified** against OSV's own answers (see above).
- ~~`unverifiable` noise~~ **Verified** negligible (see above).
- ~~Does `GENERATED ALWAYS AS (...) STORED` accept the function as IMMUTABLE, and how long does the migration take on 256k advisories?~~ **Verified (2026-10-08):** it applies, and migration 010 took about 1 s on a scratch database with 256,000 advisories and as many affected rows (laptop, local Postgres).
- 24h sweep default and batch size: a full sweep took 35 s at the lab target, so 24h is a staleness choice, not a cost one. Owner: operator; revisit with SENTRA-26.
- First-draft API shape: SENTRA-15 and 16 may need changes; keep fields additive.

## Implementation notes

Differences from the draft, and what was learned:

- **Route addressing.** The route uses the project slug (`/projects/:slug/findings`), matching the SBOM routes, not a project ID. `findProject` moved from `sbom.ts` to `projects.ts` so both share it.
- **Reverse path also looks at open findings.** Besides projects whose latest import names a changed advisory's package, it reconciles projects holding an open finding for a changed advisory. Without it, an advisory that drops a package would never close its old findings.
- **Watermark overlap.** `vulnerabilities.updated_at` is the normalizer's transaction start time, so a late-committing batch can carry an older timestamp than rows already seen. The reverse query looks back 5 minutes (tested); the re-reconcile is a no-op.
- **Unexpected errors.** An event that keeps failing is retried 5 times and then given up on; the sweep covers whatever it would have done. Infrastructure outages leave the offset uncommitted.
- **Performance.** Batched writes and cached version parsing; see "Measured" for what profiling found and the before and after numbers.
- **First sweep runs at once.** With no recorded sweep the lease is claimable immediately, so a fresh deploy reconciles every project, which is the backfill the rollout relies on.
- **npm name case.** One legacy advisory names `Openclaw`; we match npm case-insensitively, OSV exactly (see "Verified against real data").
- **Not built:** targeted reverse updates, partitioning projects across workers, alerting on a stale sweep (SENTRA-23), and everything listed under Out of scope.
