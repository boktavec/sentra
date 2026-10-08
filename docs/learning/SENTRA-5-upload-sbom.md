# SENTRA-5: Upload an SBOM

## What was built

- **Three-step upload.** The API reserves an import and signs a one-use upload, the browser sends the file straight to object storage, and a `complete` call confirms it landed.
- **An import state machine** (`pending_upload`, `uploaded`, `validated`, `rejected`, `expired`) with a stable import ID the user can poll.
- **A transactional outbox** that turns "upload accepted" into an `sbom.uploaded` event on Redpanda.
- **The first pipeline consumer** (`services/pipeline`, Python) that reads the stored file and decides `validated` or `rejected` with a reason.
- **A small UI** on the project page: file picker, imports list, status polling.

## Why it is designed this way

- **The API never touches the bytes.** An SBOM upload is a file transfer, not business logic. A presigned POST lets storage do the transfer, so API instances stay small and stateless, and one slow upload cannot hold an API connection.
- **The size cap lives in the signature, not in our code.** A presigned PUT cannot enforce a maximum size, and a presigned POST can (`content-length-range`). We tested both against SeaweedFS before choosing: an oversize POST is refused by storage and nothing is stored.
- **The server picks the object key.** `sbom/<org>/<project>/<import>.json` is built from internal IDs. The signed policy pins that one key, so a client cannot write anywhere else, and the filename a user types is only a label.
- **Validate after the file lands, in a worker.** The API can only know what the client claims. Parsing is the expensive part and belongs outside the request, so the API checks existence and size with a `HEAD`, and the pipeline checks that the content is CycloneDX JSON.
- **An outbox, not publish-after-commit.** Saving "uploaded" and publishing the event are two systems. If the process dies between them, a user's upload is stuck forever, and nobody can retry it for them. Writing the event row in the same transaction as the state change makes "uploaded" and "event owed" one fact. A relay publishes it later, at least once.
- **The pipeline reads the database row, not the event.** The event says "look at import X". Everything that matters (tenant, key, status) comes from the row, so a forged or stale event cannot point the pipeline at another tenant's file.
- **The pipeline's database role is narrow.** It can read imports and update only the result columns, so a bug or compromise there cannot rewrite who owns an import.

## Alternatives considered

- Stream the upload through the API: simpler, but API bandwidth and connections scale with uploads.
- Publish to Redpanda right after commit: simplest, but loses events on a crash.
- Validate inside the API process: fewer parts, but puts parsing in the request path and SENTRA-6 would have to move it.
- Dedupe identical uploads by hash: saves work, but hides that someone uploaded again today. SBOMs are snapshots.
- Presigned PUT: needs the exact size in advance and cannot cap it.
- SPDX alongside CycloneDX: doubles the parser surface in a story that already adds storage and messaging.

## Tradeoffs made

- Invalid or hostile files do reach storage briefly (up to the cap) before the pipeline rejects them. They sit under a tenant-scoped key, and pending uploads that never complete are deleted.
- The user sees `uploaded` for a few seconds (relay poll plus consumer time) before `validated`.
- The numbers are assumptions: 10 MiB, 15 minutes, 10 pending per project. A real `uv export` SBOM is about 3 KB per component, so 10 MiB is roughly 3,000 components; a big container image can exceed it.
- The pipeline writes to a table the API owns. The column-limited role contains the coupling; a result event handled by the API would be cleaner and costs another consumer.
- A raw object is kept forever. Retention is a follow-up once growth is measured.

## Scaling implications

- API load per upload is two small requests plus one signature, regardless of file size.
- The relay and the expiry sweep run in every API replica. `FOR UPDATE SKIP LOCKED` spreads outbox rows across them, and the partial indexes keep the claim query cheap as sent rows accumulate.
- Redpanda keys events by import ID, so one import's events stay ordered; more consumers in the `pipeline-sbom` group spread imports across partitions.
- Pipeline memory per file is bounded by the cap plus one byte.
- Outbox rows and old imports grow without limit; prune or archive with the audit data later.

## Failure and security considerations

- Redpanda down: events wait in the outbox, uploads still succeed, and `sbom_uploaded_oldest_age_seconds` grows.
- Pipeline down: imports stay `uploaded` and drain on restart. Duplicate events are harmless because the update is guarded by `status = 'uploaded'`.
- Crash after publishing but before marking sent: the event is published twice. Consumers dedupe, and the guarded update ignores the second.
- A non-member gets the same `404` as a missing org, project, or import, on every route. A malformed import ID never reaches the database.
- Retrying `complete` is safe: one outbox row and one audit event, even under parallel calls.
- SBOMs reveal internal package names, so file contents are never logged, put in events, or put in audit rows.
- Locally the API's storage identity can create buckets. A deployed identity should be limited to read, write, and list on one bucket.

## Key concepts to understand

- **Presigned POST versus PUT**, and why a POST policy can enforce limits that a PUT signature cannot.
- **Transactional outbox**: making a state change and "this must be announced" atomic, then delivering at least once.
- **At-least-once delivery and idempotent consumers**: duplicates are normal, so every step is a guarded update.
- **Row-as-authority**: events carry references; the database holds the truth about tenant and key.
- **Least-privilege database roles** for a second service that shares your schema.
- **Leases with `SKIP LOCKED`** as a cheap work queue across replicas.
