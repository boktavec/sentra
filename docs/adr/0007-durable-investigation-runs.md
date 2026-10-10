# 0007: Investigations are durable runs with a Postgres outbox

- Status: Accepted
- Date: 2026-10-08
- Amended by: [ADR 0009](0009-tenant-safe-investigation-tools.md): the "no tools" statement below no longer holds for prompt version 2. [ADR 0011](0011-validated-structured-investigation-results.md): prompt version 3 runs finish with a stored structured result instead of a draft.
- Related: [SENTRA-17 spec](../features/SENTRA-17-start-finding-investigation/spec.md), [ADR 0002](0002-event-conventions-for-async-ingestion.md)

## Context

Starting an investigation is a user action that must remain visible if the broker, worker, or local model is unavailable. A model call can take longer than an HTTP request, and duplicate clicks or event redelivery must not create duplicate active work. A later story will decide how to present evidence-backed output; this story stores only a private draft.

## Decision

- The API commits an investigation, immutable bounded finding snapshot, creation audit event, and outbox row in one Postgres transaction. It returns immediately with a queued run.
- A relay publishes a reference event to Redpanda. The Dockerized Python worker loads the authoritative row from Postgres, using the event only as a wake-up. It also sweeps due rows, so lost events cannot strand work.
- One active run per finding is enforced by a partial unique index. An organization row lock serializes concurrent starts and its pending cap. Completed and failed runs remain in history; a new start then creates a new run.
- Workers claim with a lease and use Postgres advisory lock slots for a global concurrency cap across replicas. Attempts, timeout, backoff, and output size are bounded. Expired leases consume attempts, including crashes before a failure write.
- The worker has a database role restricted to investigation lifecycle rows. The model receives the stored snapshot and fixed instructions, with no tools, database access, or tenant selector. The draft remains private and never appears in the status API.

## Alternatives considered

- Synchronous model call: simpler process layout, but ties a potentially long or failed local call to the browser request and loses durable recovery.
- Publish directly after the insert: a crash between commit and publish strands the request. The outbox removes this gap at the cost of a relay.
- Postgres-only queue: sufficient for this one worker, but Sentra already uses Redpanda and an outbox convention for asynchronous work. The database remains authoritative either way.
- LangChain or a general agent framework: extra abstraction and dependency for one authenticated chat completion. A small HTTP client makes the input, timeout, and failure policy explicit.
- Containerize oMLX: the user's MLX model runs on macOS hardware; Docker hosts only the worker and calls the authenticated host server.

## Consequences

- An event may be published or a model request may be performed more than once after a crash. Run state transitions and leases make persistence idempotent; model inference itself may be repeated and counted against capacity.
- Advisory lock slots cap simultaneous calls without a separate scheduler. This depends on Postgres availability and requires the lease to exceed the model timeout.
- A private model draft and immutable context are sensitive tenant data retained until a product retention policy is defined. SENTRA-19 must evaluate a draft before presenting a user-facing conclusion.
- Local Docker setup needs `host.docker.internal`, an oMLX API key, and the model alias advertised by `/v1/models`. These are deployment configuration, not data in the event.
- Revisit the single worker and polling cadence when measured queue age, model latency, or failure rate misses an agreed target. No product SLO is asserted yet.
