# SENTRA-17: Starting a finding investigation

Spec: [SENTRA-17](../features/SENTRA-17-start-finding-investigation/spec.md). Decision: [ADR 0004](../adr/0004-durable-investigation-runs.md).

## What was built

A project member can select an open finding on a dedicated page, start a run, and see paginated status history. The API captures a bounded, immutable finding and advisory snapshot, writes a run, outbox row, and audit event atomically, then returns. A relay publishes to Redpanda. A Dockerized Python worker calls the Mac's authenticated oMLX endpoint and saves a private draft or safe failure code. The draft is reserved for the later evidence-backed result story.

## Why it is designed this way

The browser request should finish independently of local inference. The committed Postgres row is the durable truth; an event only wakes the worker. The outbox closes the commit/publish gap, while a due-row sweep heals missed events. A partial unique index makes duplicate active starts impossible even if API replicas race. Every model call uses the snapshot from the authorized start, not a later or differently scoped finding lookup.

## Alternatives and tradeoffs

Synchronous inference would use fewer components but hold requests open and complicate recovery. A Postgres-only queue could work at current scale, but the project already uses Redpanda event delivery. A general agent framework would add dependencies without improving this single fixed completion call. Running oMLX inside Docker would lose the Mac MLX runtime. The chosen design adds a relay and worker, and a crash after inference can repeat the model call; terminal persistence stays one run.

## Scaling and operations

The initial per-organization pending cap and global model concurrency are conservative configuration, not measured product targets. Postgres advisory slots limit concurrent calls across worker replicas. Queue age, outbox depth, model duration, starts, retries, completions, and failures reveal when the cap or worker count needs changing. The primary cost is model inference; more API replicas do not increase model capacity. Worker recovery depends on Postgres and bounded leases, and broker outages delay wake-ups but not the database sweep.

## Failure and security considerations

Each route checks current membership and scopes project, finding, and run reads by organization. The worker's database role has no access to findings or memberships; it reads only the stored snapshot. The API key stays in local configuration. A failed provider response becomes a stable code, never raw model text in the API. Untrusted advisory content is data in a fixed prompt, and the model has no tools. Expired leases consume attempts so repeated crashes eventually produce a terminal failure. Private drafts and snapshots need a future retention policy.

## Key concepts

- **Transactional outbox:** save intent to publish in the same transaction as the business row, then publish it at least once.
- **Idempotent consumer:** use the run's database state to make duplicate event delivery harmless.
- **Lease and reconciliation sweep:** recover a worker crash or missed event by finding due database rows.
- **Immutable input snapshot:** make asynchronous work reproducible even if the source finding later changes.
- **Concurrency slots:** database advisory locks provide a small global cap without a scheduler, while the organization pending cap limits queue monopolization.
