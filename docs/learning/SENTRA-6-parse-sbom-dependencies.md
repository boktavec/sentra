# SENTRA-6: Parse SBOM dependencies

## What was built

- **A parser** in the existing pipeline consumer: after validating an uploaded CycloneDX file, it extracts every component that has a versioned Package URL (purl) and stores one row per package in `sbom_dependencies`.
- **A new import state**, `parsed`, with `dependency_count` and `skipped_count` shown on the project page.
- **Two new rejection reasons**: `no_components` and `too_many_components`.
- **An operator command**, `task api:sbom:reprocess IMPORT_ID=...`, that re-parses a stored file without a re-upload.

## Why it is designed this way

- **Identity is the purl.** Vulnerability sources (OSV here) key on ecosystem, package name and version. A purl carries all three in a standard form, so matching later is an equality lookup, not guesswork. Components without a usable purl are counted and reported, not stored, so a missing identity is visible instead of silently unmatched.
- **One row per package, deduped by the database.** `UNIQUE (import_id, purl)` makes the write idempotent by construction. Two components with the same purl (nested, or in different scopes) merge into one row with an `occurrences` count, and the strictest scope wins. The parser sorts its output, so the same file always produces the same rows.
- **The result is all or nothing.** Status, counts and every dependency row are written in one transaction guarded by `WHERE status = 'uploaded'`. A crash mid-write leaves nothing behind, and a duplicate delivery (Kafka is at-least-once) finds the guard already closed and writes nothing.
- **Parsing reuses the validation step.** Same event, same consumer, one extra stage. A second topic would let the stages fail independently, but it would also need another outbox and contract for an M-sized story.
- **Reprocess is "go back to `uploaded` and publish again".** The existing guard, outbox and relay already do the hard parts (idempotency, delivery), so replay needs no new code path in the consumer. Because the raw file is never deleted, a parser fix can be replayed over history.
- **No new read API.** Counts ride on the existing org-scoped endpoints. Tenant IDs on each row come from the import row, never from the file or the event.

## Alternatives considered

- A separate `sbom.validated` event and parse stage: independent retries, more infrastructure.
- Storing every component and normalizing at match time: lossless, but pushes parsing into SENTRA-13.
- Keeping `bom-ref` and the dependency graph: needed for "why do I have this", not for matching.
- Per-batch commits with progress tracking: no long transaction, but a half-parsed import.
- A member-triggered reprocess endpoint: self-service, but a new write path to authorize, audit and rate-limit.

## Tradeoffs made

- The graph and `bom-ref` are discarded; revisit when findings need a dependency path.
- Distro packages (deb, apk, rpm) are stored but have no ecosystem yet, so they will not match.
- One transaction of up to 50,000 inserts. Fine for a rare background job; the cap (assumed) bounds it.
- Users cannot retry a failed import themselves; they re-upload.

## Scaling implications

- Memory is bounded by the 10 MiB file cap. The component cap bounds rows per import.
- Rows grow with imports and are kept indefinitely; there is no retention policy yet. `(ecosystem, name)` is indexed for the matcher.
- Consumers scale by adding partitions and workers; the row lock on the import serializes two workers racing on one event.

## Failure and security considerations

- Hostile files: component count is capped, nesting is walked with a stack instead of recursion, and malformed shapes are skipped, not crashed on.
- SBOM contents (package names) are tenant-confidential: not logged, not in events or errors.
- The pipeline role gets `INSERT`, `SELECT` and `DELETE` on `sbom_dependencies` and nothing else new.
- A transient failure retries, then records `processing_failed` while keeping the raw object.

## Key concepts

- **Package URL (purl):** a standard string identifying a package by type, namespace, name and version.
- **Idempotency through constraints:** let a unique key and a guarded status transition absorb duplicates instead of checking in code.
- **Replayable pipelines:** keep raw input, make processing a pure function of it, and replay becomes a re-publish.
