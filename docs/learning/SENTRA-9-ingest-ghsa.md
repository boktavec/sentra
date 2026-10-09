# SENTRA-9: Ingesting GitHub Security Advisories

Spec: [docs/features/SENTRA-9-ingest-ghsa/spec.md](../features/SENTRA-9-ingest-ghsa/spec.md).

## What was built

`task crawler:request -- ghsa none` makes the crawler page through GitHub's REST `GET /advisories` (reviewed advisories only), store the page bodies untouched in one zip, and publish a single `artifact.ingested`. The normalizer's new GHSA adapter turns each advisory into the common vulnerability row, including `withdrawn_at`, CVSS vectors and ranges. The first run is a full backfill; later runs ask only for advisories modified since the last successful run (minus a one-hour overlap). The same advisory arriving from OSV and from GHSA stays as two provenance rows and is grouped by the existing SENTRA-12 grouper, whichever source is ingested first.

## Why it is designed this way

- **A provider is an adapter plus registry entries.** The crawler gained a `Target` entry and a fetch function; the normalizer gained `adapters/ghsa.py` and one line in `ADAPTERS`. Nothing downstream (matching, grouping, findings) knows about GitHub.
- **REST, not the advisory-database archive.** The archive is OSV-format and would mostly reuse the OSV adapter, skipping the behaviors this story exists to exercise: a credential, pagination and rate limits.
- **Pages as zip entries.** One raw artifact per run keeps the existing `(artifact_sha256, adapter_version)` dedupe, key layout and zip-bomb limits. The zip is written with fixed entry timestamps, so identical upstream content produces an identical hash and "nothing changed" is detectable by comparing hashes.
- **The watermark is derived, not advanced.** It is a column on the run that fetched the data, and the baseline for the next run is the latest `published` or `unchanged` run. A run that fails, or stores an artifact but never publishes the event, is never the baseline, so the "advance only after success" rule needs no extra transaction.
- **Ascending `updated` order plus an overlap window.** An advisory edited while we paginate moves to the end of an ascending list and is still reached; the overlap re-fetches recent rows in case it was not. Re-fetched rows are harmless because the normalizer only rewrites a row when the source's `updated_at` is newer.
- **Rate limits are a first-class outcome.** The crawler paces on `x-ratelimit-remaining`, honors `Retry-After` and the reset time, and sleeps only if the wait fits the run's remaining time budget; otherwise the run fails as `rate_limited` and a later request retries from the same watermark.
- **The token is a typed secret.** `Secret` has no readable `repr`/`str`, so it cannot leak through logs, a dataclass dump or an exception message. It is sent only to the one API origin, a pagination link pointing elsewhere fails the run, and redirects are not followed.
- **Withdrawn advisories are stored, not skipped.** Skipping would leave an active row behind when an advisory is later withdrawn. The correlator already resolves findings for withdrawn rows.

## Alternatives considered

GraphQL (points-based limits, no gain); the OSV-format advisory archive; one artifact per page (breaks one-run-one-event); a separate watermark table; extending the grouper in this story (gaps are follow-ups instead).

## Tradeoffs

- A failed run stores nothing, so a failure at page 200 of a full backfill restarts the backfill. Rate-limit waiting keeps a worker busy (the claim lease already covers the whole run budget).
- Unchanged detection is "nothing newer than the watermark". An advisory changed in the same second as the watermark, after our fetch, waits until any newer advisory triggers a bundle.
- Ranges the model cannot express exactly (`> 1.0`) are quarantined rather than widened.
- Only `npm` and `PyPI` ranges are verifiable by the matcher; other ecosystems are stored but reported `ecosystem_unsupported`.

## Scaling implications

The advisory set is on the order of tens of thousands of records: a full run is a few hundred requests (page size 100 is the API maximum) and is rate-limit-bound, not CPU-bound. Pages are held in memory one at a time and the bundle is staged in a temp file. Incremental runs are a handful of requests. There is one GHSA run at a time (the run lease). Real sizes and duration still need the first authenticated run.

## Failure and security considerations

- Missing or malformed token fails before any request; the token never reaches logs, events, the sidecar or the run table (a test greps every surface after a success and a 401).
- A malformed page, a non-array body or an advisory without `updated_at` fails the run and leaves no temp file or artifact. A bad advisory inside a good page is quarantined by `page-N.json[index]`.
- The normalizer's quarantine and failure-rate limits apply unchanged.

## Key concepts

- Watermarks and overlap windows for incremental sync, and why the baseline should be a property of completed work.
- Honoring `Retry-After` and `x-ratelimit-*`, and bounding waits by a deadline.
- Secrets as types, and pinning credentials to an origin.
- Identity by shared identifiers (`GHSA-...` and `CVE-...`) across sources instead of by source.
