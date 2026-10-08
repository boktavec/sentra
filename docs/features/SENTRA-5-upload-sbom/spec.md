# SENTRA-5: Upload an SBOM to a project

- Status: Implemented, in review
- YouTrack: http://localhost:8080/issue/SENTRA-5 (Project & Asset Management, P1, size L)
- Owner: Brian Oktavec

## Problem and outcome

- **Who/why:** A project member needs to tell Sentra what software their application contains. The SBOM (Software Bill of Materials, a machine-readable list of an application's packages and versions) is the first tenant-provided inventory. SENTRA-6 parses it into dependencies and SENTRA-13 matches those against vulnerabilities, so nothing downstream works without a safe, replayable upload.
- **Done means:** A member uploads a CycloneDX JSON file to a project from the web app or API, receives a stable import ID, and watches the import move to `validated` or `rejected` with an understandable reason. The raw file is kept in object storage under a server-chosen tenant-scoped key, processing is asynchronous, and the upload is audited.

## Scope

- In scope:
  - Migration `007`: `sbom_imports` and `sbom_outbox` tables, plus a limited-privilege database role for the pipeline.
  - API: create import (returns a presigned upload), complete import, list, get.
  - Transactional outbox relay in the API that publishes `sbom.uploaded` to Redpanda.
  - Python pipeline consumer (first real code in `services/pipeline`) that validates the file and sets `validated` or `rejected`.
  - Pending-import expiry sweep and orphaned-object cleanup.
  - `sbom.uploaded` v1 event contract in `packages/contracts/events/`.
  - Web: file picker and imports list with status polling on the project page.
  - Logs, metrics, tests, learning note.
- Out of scope (future work):
  - SPDX or any non-CycloneDX format (own story).
  - Parsing components into dependency records (SENTRA-6).
  - Raw file download by users (replay is pipeline-only).
  - Delete or replace an import, retention or lifecycle policy for raw objects.
  - Per-org upload rate limit (existing limiter covers failed auth only).
  - Dedupe by content hash (SENTRA-6 may skip repeated work by `sha256`).
- Dependencies and related stories:
  - New dependencies: `@platformatic/kafka` (pure TypeScript Kafka client for the relay; `kafkajs` has had no release since 2023 and the Confluent client needs a native addon), `@aws-sdk/client-s3` and `@aws-sdk/s3-presigned-post` (HEAD, delete, bucket setup and the presigned POST; no smaller maintained option signs POST policies).
  - Depends on SENTRA-4 (done): projects, `TenantContext`, `scopeTo`, audit events.
  - **Builds on SENTRA-7's infrastructure** (SeaweedFS and Redpanda in `compose.yml`, ADR 0002 event conventions), now merged. Main has two `006_*` migrations (`006_ingestion_runs.sql`, `006_projects.sql`); the runner tracks them by filename so both apply, and this story takes `007`.
  - SENTRA-6 extends the pipeline consumer built here. SENTRA-20 reads the audit event; SENTRA-21 adds SBOM imports to the cross-tenant suite.

## Decisions and alternatives

Claims about SeaweedFS were checked on 2026-10-07 against a throwaway `chrislusf/seaweedfs:4.20` container (the tag in SENTRA-7's `.env.example`), using boto3 with SigV4 path-style addressing.

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| SBOM format | CycloneDX JSON only | SPDX JSON; both | Security-oriented `components[]` with purls; official JSON Schema; emitted by Syft, Trivy, cdxgen. SPDX-only shops need a later story. |
| Dependency on SENTRA-7 infra | Build on its SeaweedFS and Redpanda with ADR 0002 conventions; implement after its infra PR merges | Postgres-only outbox worker; duplicate the infra here | One event architecture. Cost: implementation is sequenced behind SENTRA-7. |
| Upload path | Presigned upload straight to object storage; API never touches the bytes | Stream through the API; stream now with a replaceable contract | Stateless API, no upload bandwidth or memory per request. Cost: three-step flow, extra states, orphan cleanup, browser must reach storage (CORS). |
| Signing style | Presigned **POST** with a `content-length-range` policy | Presigned PUT with signed `Content-Length` | **Verified:** POST policy rejects an oversize body with `EntityTooLarge` and stores nothing; PUT with a signed length rejects a mismatched body with `403 SignatureDoesNotMatch` but needs the exact size in advance. POST lets the cap apply without trusting a client-declared size. |
| Size and type validation | Cap enforced by the POST policy (10 MiB, config); content (JSON, `bomFormat`, `specVersion`) validated by the pipeline | Also read the object on `complete` | Fast accept, understandable `rejected` status. Invalid files land in storage briefly, under a tenant-scoped key. `complete` does a cheap `HEAD` (exists, size within cap), not a read. |
| Size cap | 10 MiB, configurable | 50 MiB | **Assumed.** Typical SBOMs are KB to a few MB, parse is in-memory. Validate against real Syft and cdxgen output (including one large container image) before merge and adjust. |
| Repeat uploads | Every upload is a new import with its own ID; `sha256` recorded by the pipeline | Dedupe by content; `Idempotency-Key` | An SBOM is a point-in-time snapshot. Retrying `complete` on the same import is idempotent. Cost: duplicate objects and parse work for identical files. |
| Event handoff | Transactional outbox in the API relayed to Redpanda | Publish after commit; worker polls Postgres | Atomic with the status change, survives crashes and broker outages, reuses the SENTRA-29 lease pattern. Cost: a relay loop and an outbox table to prune later. |
| Processing location | Minimal validator in the Python pipeline service | In the API process; stop at publishing | Matches the planned architecture and SENTRA-6 extends it in place. Cost: first Python consumer and a second service touching Postgres. |
| State write-back | Pipeline updates `sbom_imports` directly with a role limited to status and reason columns, guarded by `WHERE status = 'uploaded'` | Result events consumed by the API; internal API call | Same pattern as SENTRA-7's crawler. Cost: shared-schema coupling, contained by the role. |
| User retrieval | List and get return metadata and status only | Presigned download endpoint | Smallest isolation surface; nothing in the MVP needs a re-download. |
| Abuse limits | Signed policy valid 15 minutes; pending imports expire; at most 10 pending per project (`429` beyond); any org member may upload | TTL only; per-org rate limit | **Assumed** numbers, all configurable; validate in SENTRA-26/27. |
| Web scope | Minimal UI on the project page: picker, imports list, status polling | API only; form only | Covers every criterion in the browser. Cost: CORS to SeaweedFS and a Playwright upload flow. |
| Unauthorized access | Non-members and cross-org or unknown IDs get the same `404` | `403` | Existence is not revealed (as SENTRA-4). |

Other behavior verified against the running probe:

- **Verified:** SeaweedFS accepts `put_bucket_cors` and answers a preflight from an allowed origin with the matching `Access-Control-Allow-Origin`, so browser upload from the web origin is feasible locally.
- **Verified (integration test, `sbom.integration.test.ts`):** a form whose `key` field was changed after signing is rejected by storage, so a client can write only to the key the server chose.
- **Verified (probe against Redpanda v25.1.1):** `@platformatic/kafka` does not auto-create topics (`Unknown topic`), unlike librdkafka. The API creates `sbom.uploaded` itself only when `SBOM_DEV_BOOTSTRAP=1` (single replica, local only); deployed environments provision topics.
- **Verified (documentation via context7, CycloneDX spec):** JSON serialization exists from spec 1.2. The pipeline accepts `specVersion` 1.4 to 1.7 and rejects 1.2 and 1.3 as `unsupported_version`. A real `uv export --format cyclonedx1.5` file validates.
- **Verified (running stack):** the bucket needs a CORS rule for the web origin, which the API applies at startup when `SBOM_DEV_BOOTSTRAP=1`. A deployed bucket must be configured by its operator.

## Architecture and contracts

- **Affected components and ownership:**
  - `apps/api`: import model, authorization, signing, outbox, relay, expiry sweep, audit.
  - `services/pipeline`: validator consumer, writes status.
  - `apps/web`: UI only, no authorization logic.
  - `packages/contracts/events/`: `sbom.uploaded` v1 schema.
  - Object storage and Redpanda from SENTRA-7's compose changes.
- **Import state machine:**

  ```
  pending_upload --complete--> uploaded --pipeline--> validated
        |                          |
        | (TTL passes)             +--pipeline--> rejected(reason_code)
        v
     expired
  ```
  Terminal: `validated`, `rejected`, `expired`. SENTRA-6 adds later states.

- **Request flow (create):**
  1. The protected route group authenticates; `scopeTo` resolves membership into `TenantContext` (non-member: `404`); the project is looked up by slug within that org (unknown: `404`).
  2. Validate `filename` (length, no path or control characters) and declared `size_bytes` against the cap. Invalid: `400`. The filename is metadata only and is never used in the object key.
  3. In one transaction: count the project's `pending_upload` imports (>= cap: `429`), insert the import with a server-generated UUID, object key `sbom/<org_id>/<project_id>/<import_id>.json`, and `expires_at`.
  4. Sign a POST policy for exactly that key with `content-length-range [1, cap]` and expiry. Return `201 {id, status, upload: {url, fields}}`.
- **Upload (client to storage):** the client posts the form fields and file to `upload.url`. The API is not involved.
- **Request flow (complete):** `POST .../sboms/:id/complete`.
  1. `scopeTo`, then load the import by `(org_id, project_id, id)` (else `404`).
  2. Already `uploaded` or beyond: return the current import (idempotent `200`). `expired`: `409`.
  3. `HEAD` the object. Missing: `409 upload_missing`. Size over cap or zero: `409 upload_invalid`, import becomes `rejected(size)`.
  4. One transaction: set `uploaded` guarded by `WHERE status = 'pending_upload'`, record `size_bytes`, insert the `sbom.uploaded` outbox row, insert the `sbom.upload_completed` audit event. Return `200`.
- **Relay:** an in-process loop (SENTRA-29 pattern: `FOR UPDATE SKIP LOCKED`, lease by pushing `next_attempt_at`) publishes outbox rows to Redpanda and marks them sent. At-least-once.
- **Validation (pipeline):** consume `sbom.uploaded`, dedupe by `event_id`, read the object by the referenced key, verify size, parse JSON, require `bomFormat == "CycloneDX"` and a supported `specVersion`, compute `sha256`. `UPDATE sbom_imports SET status = ..., reason_code = ..., sha256 = ... WHERE id = $1 AND status = 'uploaded'`; zero rows updated means a duplicate and is skipped. Exhausted retries on a transient failure record `rejected(processing_failed)`, publish nothing new, and commit the offset per ADR 0002.
- **Expiry sweep:** a small API loop moves `pending_upload` rows past `expires_at` to `expired` and deletes any object at their key.
- **Storage contract (migration `007_sbom_imports.sql`):**
  - `sbom_imports(id uuid pk, org_id uuid not null references organizations, project_id uuid not null references projects, created_by uuid not null references users, filename text not null, status text not null check (...), reason_code text, size_bytes bigint, sha256 text, object_key text not null unique, expires_at timestamptz not null, created_at, updated_at)`. Index `(project_id, created_at desc, id)` for the list; partial index on `(expires_at) where status = 'pending_upload'` for the sweep.
  - `sbom_outbox(id uuid pk, import_id uuid not null references sbom_imports, payload jsonb not null, next_attempt_at, attempts, sent_at)` with a partial index on unsent rows.
  - Database role `sentra_pipeline`: `SELECT` and column-limited `UPDATE (status, reason_code, size_bytes, sha256, updated_at)` on `sbom_imports` only.
- **API contracts** (RFC 9457 error bodies from `@sentra/ts-platform`):

  | Route | Success | Errors |
  | --- | --- | --- |
  | `POST /v1/orgs/:orgId/projects/:slug/sboms` `{filename, size_bytes}` | `201` `{id, status, expiresAt, upload: {url, fields}}` | `400`, `401`, `404`, `429 too_many_pending` |
  | `POST /v1/orgs/:orgId/projects/:slug/sboms/:id/complete` | `200` import | `401`, `404`, `409 upload_missing`, `409 upload_invalid`, `409 expired` |
  | `GET /v1/orgs/:orgId/projects/:slug/sboms?limit&cursor` | `200` `{items, nextCursor}` | `400`, `401`, `404` |
  | `GET /v1/orgs/:orgId/projects/:slug/sboms/:id` | `200` `{id, filename, status, reasonCode, sizeBytes, sha256, createdAt, updatedAt}` | `401`, `404` |

- **Event contract:** `sbom.uploaded` v1 with ADR 0002's envelope (`eventId`, `type`, `version`, `timestamp`, `correlationId`) plus `importId`, `orgId`, `projectId`, and `artifact` (`bucket`, `key`, `sizeBytes`). Field names are camelCase like the other events; the topic is `sbom.uploaded`, keyed by `importId`. References only, no payload and no URL. Tenant IDs in the event are for routing and logging; the pipeline loads the import row by `import_id` and treats the row as authoritative.
- **Compatibility and migration:** additive tables and an additive event; no existing contract changes. The audit `AuditEvent.targetType` union gains `"sbom_import"`.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | **Unknown.** Create and complete are rare per project; list and get run on project page views and status polling | No target invented | Measure in SENTRA-26/27 |
| Concurrent users or jobs | **Unknown.** Bounded abuse: 10 pending per project | Config cap, **assumed** | Concurrency test checks the cap holds under parallel creates |
| Data size and growth | Up to 10 MiB per import, kept indefinitely; one row, one outbox row, one audit row each | **Assumed** cap; no retention policy yet | Record real sizes; revisit retention when the bucket has measured growth |
| Latency or throughput target | **Unknown.** Create and complete do only indexed queries plus one signature and one `HEAD`; no byte handling | Design property | Check query plans in tests; baseline in SENTRA-26 |
| Availability and recovery target | **Unknown.** Create needs Postgres only (signing is local). Complete also needs object storage; relay and validation need Redpanda | Design property | Dependency-outage tests below |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Invalid filename or `size_bytes` (empty, over cap, non-integer, control characters) | `400`, no row written | Unit and API tests |
| Upload exceeds the cap | Storage rejects (`EntityTooLarge`), nothing stored; `complete` returns `409 upload_missing` | Integration test against Seaweed |
| Object missing at `complete` | `409 upload_missing`; import stays `pending_upload` until it expires | API integration test |
| Client posts to a different key, or the form fields are altered | Storage rejects the signature or policy | Integration test against Seaweed |
| Not JSON, wrong `bomFormat`, unsupported `specVersion`, empty object | `rejected` with a reason code the UI explains | Pipeline test with fixtures; Playwright |
| Valid SBOM | `validated`, `sha256` recorded | Pipeline integration test with a real CycloneDX fixture |
| Duplicate `complete` (retry, double-click) | `200` with the current import; one outbox row, one audit event | API test, sequential and parallel |
| Duplicate `sbom.uploaded` delivery | Second update touches zero rows; no state regression | Pipeline test |
| Crash between commit and publish | Outbox row remains due; relay publishes on next tick | Integration test killing the relay mid-batch |
| Redpanda unavailable | Outbox rows wait; relay backs off; import stays `uploaded`; queue gauge rises | Stop the broker in an integration test |
| Object storage unavailable on `complete` | `5xx` generic problem body; import stays `pending_upload`, retryable | Integration test |
| Pipeline down | Imports stay `uploaded` and drain on restart; `uploaded` age gauge makes it visible | Failure test |
| Transient read failure in the pipeline | Bounded retries with backoff, then `rejected(processing_failed)` | Pipeline test with injected failure |
| Pending expires | Sweep sets `expired` and deletes the object; late `complete` returns `409 expired` | Integration test with a short TTL |
| 11th pending import in a project | `429` | Concurrency test |
| Non-member creates, completes, lists, or gets | `404`, identical to a nonexistent org or project; no row, no signed URL | API integration tests |
| Import ID from another org or project | `404` | API integration test |
| Body carries `org_id`, `object_key`, `created_by`, or `status` | Ignored; server derives all of them | API test |
| Bad or tampered cursor | `400`; no other tenant's rows appear | API integration test |
| Web: file over the cap or wrong extension | Message before any request is sent | Playwright |
| Web: unauthenticated or non-member | Redirect to sign-in or standard not-found page | Playwright |

## Security, observability, and rollout

- **Authorization, tenant isolation, sensitive data, and abuse limits:**
  - All authorization is server-side. Tenant comes from the route, is checked against `memberships`, and every query filters by `tenantContext.orgId` and the project.
  - The server chooses the object key from internal IDs. The client never supplies a key, path, or filename used in storage.
  - The signed policy covers one key, a size range, and a short expiry. Storage credentials never reach the browser.
  - The pipeline role can read and update only the import columns listed; it holds no other table privileges. The pipeline reads the object by the key stored on the import row, not by an event-supplied key.
  - SBOMs can reveal internal package names and versions. They are treated as tenant-confidential: not logged, not in events, not in audit rows, and not in error bodies.
  - Audit rows carry the internal user UUID, import ID, filename, and project slug only (no file content).
  - Abuse: 10 pending per project, 15-minute policy, 10 MiB cap, all configurable.
- **Logs, metrics, traces, and alerts:**
  - Logs (with correlation ID): `sbom_import_created`, `sbom_import_completed`, `sbom_import_rejected` (reason), `sbom_import_expired`, `sbom_event_published`, `sbom_validation_done`.
  - Metrics: `sbom_import_transitions_total{to,reason}`, `sbom_outbox_pending` and oldest-age gauges, `sbom_uploaded_oldest_age_seconds`, `sbom_validation_duration_seconds`, `sbom_object_size_bytes` histogram.
  - Correlation ID travels in the `sbom.uploaded` envelope into pipeline logs.
  - No alerts (SENTRA-23).
- **Rollout, migration, rollback, operational owner:**
  - Migration `007` runs on API startup via `migrate`.
  - Rollback: drop the two tables and the role; objects in the bucket are orphaned and can be removed by prefix `sbom/`.
  - Pipeline and API deploy independently. Events are additive, so an old pipeline ignores nothing it needs.
  - Owner: Brian Oktavec.

## Acceptance criteria

- [x] A member (`admin` or `member`) can upload a CycloneDX JSON SBOM to a project through the web UI and the API.
- [x] The upload cap is enforced by storage (signed policy), the declared filename and size are validated, and non-CycloneDX or malformed content ends as `rejected` with an understandable reason.
- [x] The raw artifact is stored in object storage at a server-chosen tenant-scoped key.
- [x] Each import records the correct organization and project and returns a stable import ID.
- [x] Processing happens asynchronously after `complete`: an `sbom.uploaded` event is published through a transactional outbox and consumed by the pipeline.
- [x] A duplicate `complete` or duplicate event produces one import transition, one audit event, and no state regression.
- [x] A user cannot create, complete, list, or get imports in an org or project they do not belong to, and cannot reference another tenant's import ID; responses are the same `404` as a nonexistent resource.
- [x] Pending imports expire after the configured window and their orphaned objects are removed; a project cannot hold more than the configured number of pending imports.
- [x] Import state transitions and outbox and validation health are observable through logs and metrics.
- [x] An `sbom.upload_completed` audit event is written in the same transaction as the `uploaded` transition.

## Verification

- Manual checks and expected results:
  - `task` brings up Postgres, SeaweedFS, Redpanda, the API, the pipeline consumer and the web app. On a project page, choose a real Syft-generated CycloneDX file: the import appears as `pending_upload`, then `uploaded`, then `validated` without a page reload.
  - Choose a JSON file that is not CycloneDX: it ends `rejected` with the reason shown.
  - Choose a file over 10 MiB: blocked in the browser; a direct POST to storage is rejected.
  - Stop the pipeline, upload, restart: the import drains to `validated`.
  - Sign in as a user in another org and request the first org's import ID: `404`.
  - Record real SBOM sizes (small service, monorepo, large container image) and adjust the cap if needed.
- Automated tests and what they prove:
  - Unit: input validation, state machine transitions, key construction, outbox lease and backoff, CycloneDX validation rules (Python).
  - API integration (real Postgres, Seaweed, Redpanda): the full create, upload, complete flow; idempotent complete; parallel complete and parallel create against the pending cap; atomicity (forced audit failure rolls back the transition and outbox row); tenant isolation on every route.
  - Pipeline integration: valid fixture, malformed fixtures, duplicate delivery, injected read failure, role privilege check (an `UPDATE` on another column or table fails).
  - Contract test: the published `sbom.uploaded` validates against its JSON Schema and the consumer rejects an invalid one.
  - Playwright: upload happy path, rejection reason display, over-cap and wrong-type messages, non-member not-found. Screenshots committed under `docs/features/SENTRA-5-upload-sbom/screenshots/`.
- Load or failure tests, if relevant:
  - Dependency-outage tests listed above (Redpanda, object storage, pipeline down). No load test; baseline belongs to SENTRA-26/27.

## Open questions and assumptions to validate

- Real SBOM size distribution and the 10 MiB cap: **partly validated.** Syft, Trivy and cdxgen were not installed here. A real `uv export --format cyclonedx1.5` of the pipeline's runtime dependencies (18 components, pretty-printed) is 59 KB, roughly 3 KB per component, so 10 MiB holds on the order of 3,000 components. A large container image can exceed that. Re-check with Syft output on a real image before relying on the cap (owner: Brian).
- TTL (15 min), pending cap (10), and sweep interval are guesses: measure in SENTRA-26/27.
- Supported CycloneDX `specVersion` list (1.4 to 1.7): confirm against what Syft and cdxgen emit by default.
- Retention for raw SBOM objects and old imports: follow-up once growth is measured.
- Per-org upload rate limit: follow-up if abuse appears.
- Local credentials: the API identity in `seaweedfs-s3.json` has `Admin` so it can create the bucket and its CORS rule locally; deployed environments should scope it to read, write and list on the one bucket (owner: Brian, before any shared environment).
- `PIPELINE_MAX_SBOM_BYTES` must be at least `SBOM_MAX_BYTES`; the two are configured separately.
