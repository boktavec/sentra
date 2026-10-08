# SENTRA-11: Normalizing vulnerability records

Spec: [docs/features/SENTRA-11-normalize-vulnerabilities/spec.md](../features/SENTRA-11-normalize-vulnerabilities/spec.md). Model reference: [packages/contracts/models.md](../../packages/contracts/models.md).

## What was built

A second pipeline process that turns raw OSV dumps (stored by the crawler) into one canonical vulnerability model in Postgres. `artifact.ingested` goes in; the worker downloads the zip, streams it entry by entry through an OSV adapter, validates each record against a JSON Schema, upserts valid ones in batches, quarantines the rest, and publishes `vulnerabilities.normalized` when the artifact is done. On the real data: PyPI 26,143 records in about 9 s, npm 230,171 in about 38 s, zero failures.

## Why it is designed this way

- **Adapter vs domain.** Only `normalize/adapters/osv.py` knows OSV's field names. Everything after it takes the canonical record, so the KEV and GHSA stories add an adapter and a mapping table, not changes to storage or matching.
- **Keep the raw ranges.** In PyPI, 5,529 `affected` entries have only a `versions` list and 7,213 have only `ranges`, so both are stored. The model keeps range *events* as the source gives them. Deciding whether `1.4.2` is inside `[1.0, 1.4.2)` depends on the ecosystem's version rules (semver, PEP 440), and that belongs in the matching story, where a bug can be fixed without rewriting stored data.
- **Idempotency by comparison, not by bookkeeping.** An upsert is guarded by `modified` (newer wins) or `adapter_version` (newer adapter wins). Replaying an artifact, delivering it twice, or processing an older artifact after a newer one all end in the same table. The test that proves it also had to be proven able to fail: loosening the guard made three tests fail.
- **Quarantine instead of aborting.** One odd advisory should not stop all vulnerability updates, so bad records go to `normalization_failures` with the artifact SHA-256 and zip entry. A failure-rate limit stops the run when the adapter itself is broken, so a bad deploy cannot quietly replace good data with nothing.
- **Versioned rows.** `schema_version` and `adapter_version` on each row answer "which rows were produced by the old code?" and make a fix-and-reprocess migration safe, because the raw artifact is kept.
- **A lease, not a lock.** `normalization_runs` has one row per artifact and adapter version with a lease renewed on every batch. If a worker dies, the lease expires and another retakes the run; the batch that renews the lease also fails if the run was retaken, so a slow worker cannot keep writing.

## Alternatives considered

Normalized JSON in object storage (not queryable, deferred the real decision); precomputing version intervals now (bakes a version-parsing bug into stored data); all-or-nothing artifacts (one bad record blocks everything); per-advisory events (hundreds of thousands of events on a first import with nobody consuming them); checkpointed resume (idempotent upserts already make a restart safe, and the full npm run is under a minute).

## Tradeoffs

- Every new artifact is read in full even if one advisory changed (npm: about 26 s to confirm nothing changed). Cheap now; a changed-entry diff is the optimization if it ever matters.
- `GIT` ranges are dropped, so advisories whose only data is a commit range match nothing. An SBOM has package versions, so there is nothing to compare.
- `MAL-` malware reports are about 45% of PyPI and 97% of npm records. They are stored like any advisory; later stories may want to treat them differently.
- Two ecosystems sharing an advisory ID (47 GHSA records) is safe only because OSV repeats the full record in both files. That was checked, not assumed.

## Scaling implications

Memory is bounded by one entry plus one batch (a 1.1 MiB largest entry, batches of 500), not by the dump; the zip goes to a temp file because zip needs random access. The first npm import is about 460 batches and 38 s on a laptop. More ecosystems mean more of the same, in parallel by artifact (one lease each). The single-row upsert is the part to measure if Postgres becomes the bottleneck; the batch size (500) is an untuned assumption.

## Failure and security considerations

- The pipeline reads only `raw/<source>/<ecosystem>/<sha256>.zip` and checks the bytes hash to that SHA-256, so an event cannot point it at another object.
- A zip is untrusted input even from a trusted source: limits on entries, bytes per entry and total bytes are checked on declared and actual sizes, and a tripped limit fails the run before any later entry is read.
- The normalizer's database role cannot read tenant tables (tested), because the process that unzips outside data is the one most worth confining.
- A crash after the last batch commits and before the event is sent is recovered by redelivery: the run is `completed`, so the event is simply sent. The event ID is fixed per run, so a duplicate is detectable.

## Key concepts to understand

Idempotent upsert with a guard condition; at-least-once delivery and why commit-before-publish needs a recoverable state; leases versus locks; schema validation at a trust boundary; streaming versus loading; quarantine (dead-letter) tables and failure-rate circuit breakers; versioning derived data so it can be regenerated from raw input.
