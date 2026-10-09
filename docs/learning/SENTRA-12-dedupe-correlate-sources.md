# SENTRA-12: Consolidating overlapping vulnerability sources

Spec: [docs/features/SENTRA-12-dedupe-correlate-sources/spec.md](../features/SENTRA-12-dedupe-correlate-sources/spec.md). Decision record: [ADR 0005](../adr/0005-advisory-groups-over-advisories.md).

## What was built

A grouper job that links advisories describing the same issue (a GHSA, a PYSEC and a CVE record, plus the `cisa-kev` stub from SENTRA-8) into a **group**, and a findings list that shows one item per issue instead of one per advisory. Each item carries `sources[]`, so every advisory that was merged in stays visible. The grouper writes three additive tables and never modifies an advisory row.

## Why it is designed this way

- **A layer on top, not a merge.** Advisories are replayable facts from raw artifacts (SENTRA-11). Merging rows would throw away provenance and fight the `(source, source_id)` upsert. Groups are derived, so they can be rebuilt at any time.
- **Connected components over shared identifiers.** If two advisories share any id or alias they are the same issue. It is deterministic and explainable, and it catches pairs with no CVE between them.
- **Refuse when unsure.** One wrong alias would chain unrelated advisories together. A component with more than one CVE id, or whose advisories share no affected package, is not merged. Every member stays alone and the reason is recorded. A leftover duplicate is visible and harmless; a wrong merge hides a real finding.
- **Ids from data, not from a counter.** A group's id is a UUIDv5 of its canonical member, so rebuilding from scratch gives identical ids. When a merge or split changes the canonical member, the old group keeps a `merged_into` pointer. Canonical prefers advisories that list packages, so a KEV stub (whose source sorts first) does not lead.
- **Recompute the whole component, idempotently.** The grouper reloads the full component around each changed advisory plus the group it came from, so splits are seen as well as merges. Reruns and replays converge on the same rows. A Postgres advisory lock keeps one grouper running.
- **Findings stay per advisory.** The correlator is unchanged. Collapsing happens when reading, with a fallback to the advisory itself while the grouper lags, so lag can only show a duplicate, never hide a finding.

## Alternatives considered

Rekeying findings to the group (one finding per issue by construction, but reworks the SENTRA-13 key and reconcile); merging advisory rows; grouping inline in the normalizer (couples two jobs, harder to replay); computing groups at read time only (no stable id, no conflict record); splitting a bad component by CVE (more rules, still wrong when aliases are bad).

## Tradeoffs

- The list query computes groups with a window function over the project's findings on every page. Fine for lab-sized projects; unmeasured. A stored group key on `findings` is the upgrade.
- The item id is the lead finding's id and can change if the lead changes. SENTRA-16 (detail view) must address by something stabler if that matters.
- Severity and summary come from the canonical advisory as-is. Real cross-source severity is SENTRA-14.
- The guard and the alias-symmetry assumption have not been checked on real OSV dumps yet.

## Scaling and failure

- Grouping lag is bounded by the poll interval; a crashed pass leaves the watermark behind and the next pass redoes it. A component's cost grows with its size, so an alias shared by thousands of advisories would be loaded whole (noted in the code).
- Groups are global like advisories and hold no tenant data. Tenant isolation is still enforced by the findings query: one tenant's finding on a shared group never appears in another tenant's list (tested).

## Key concepts

Derived vs source-of-truth data; connected components and why a guard is needed; deterministic ids for replayability; failing safe (singletons plus a conflict record) instead of guessing; keyset pagination over an aggregate.
