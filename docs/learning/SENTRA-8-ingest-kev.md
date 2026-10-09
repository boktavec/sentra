# SENTRA-8: Ingesting the CISA KEV catalog

Spec: [docs/features/SENTRA-8-kev-ingestion/spec.md](../features/SENTRA-8-kev-ingestion/spec.md). Decision record: [ADR 0004](../adr/0004-kev-as-enrichment-plus-linked-vulnerability-rows.md).

## What was built

The crawler can fetch a second source, the CISA Known Exploited Vulnerabilities catalog, and the normalizer turns each snapshot into a `kev_entries` table plus a linked `cisa-kev` row per CVE in `vulnerabilities`. A view, `vulnerability_kev_status`, answers "is this vulnerability in KEV?" for any row, including OSV and GHSA advisories that list the CVE as an alias. `task crawler:request -- cisa-kev none` publishes the signed request by hand until SENTRA-10 schedules it.

## Why it is designed this way

- **Reuse the pipeline, generalize the edges.** Signing, leases, retries, content-addressed raw storage and run tables already existed. KEV needed only a per-source target (URL, file type, expected first bytes) in the crawler and a different reader in the normalizer. A standalone job would have copied all of that.
- **An enrichment table, not just another source.** KEV is facts about a CVE ("exploited, due date, ransomware use"), not an advisory about a package. Forcing it into `vulnerabilities` needs a made-up modified time and a vendor "ecosystem" that would pollute package matching. The stub row is kept so KEV stays visible where vulnerabilities are listed, but it has no affected rows and cannot match a dependency.
- **Tombstones, not deletes.** CISA can remove an entry. Setting `removed_at` keeps the history and makes "in KEV" a plain filter, while the raw snapshots stay the replayable record.
- **A snapshot must be whole before it can remove anything.** Mass removal is the dangerous failure here: a truncated or empty download looks identical to "CISA removed everything". So the count must match, and one snapshot may remove at most max(5, 10%) of active entries, or the run fails and nothing is written. An operator can raise the limit and retry. The 10% is an assumption, not a measurement.
- **A bad entry is not a removal.** An entry that fails mapping is quarantined, but its CVE still counts as listed, so one malformed record cannot flip a real KEV entry to "absent".

## Alternatives considered

Canonical rows only (what `models.md` first sketched); enrichment only; stub rows only when no alias match exists (depends on ingestion order); a standalone fetch-and-load job; an API route or `kev` flag on findings now (left to SENTRA-14 and SENTRA-16).

## Tradeoffs

- A CVE can appear as both an OSV row and a `cisa-kev` row until SENTRA-12 consolidates sources.
- The `kev_entries` transaction and the stub batches are separate transactions. Both are idempotent and the run is retried, so a crash between them heals itself, but the view reads `kev_entries` only.
- CISA ignores `If-None-Match` (**Verified**: it returns 200), though it honors `If-Modified-Since`. Each run downloads 1.7 MiB and relies on the `sha256` comparison. That is cheap enough that adding a `last_modified` column was not worth it.
- A tombstoned CVE keeps its stub row in `vulnerabilities`.

## Scaling implications

About 1,700 entries and 1.7 MiB: one snapshot is a single transaction and a few batches, so size is not a concern. The `vulnerability_kev_status` view uses a primary-key lookup per vulnerability (`cve_id = ANY(aliases || source_id)`), which stays cheap over the 230,000+ OSV rows. KEV changes do not wake the correlator; SENTRA-14 must decide how a KEV change reaches prioritization.

## Failure and security considerations

- The normalizer role can read and write `kev_entries` but cannot delete from it (tested).
- The feed URL is operator config, never event data; the body must start with `{`, so an HTML error page served as 200 fails the run without being stored.
- The adapter was run over all 1,739 live entries: none failed validation. Real fixtures, not invented ones, drive the tests.

## Key concepts

- Enrichment versus canonical data, and linking by alias until real deduplication exists.
- Tombstoning and why a whole-snapshot sanity check must come before it.
- Content hashes as an update guard when the source has no modified time.
- Verifying a third party's HTTP behavior instead of assuming it (the `If-None-Match` surprise).
