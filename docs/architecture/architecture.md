# Sentra Architecture

## Purpose

Sentra is a scalable, multi-tenant security intelligence platform built with TypeScript and Python.

The system ingests external software/security data, preserves the raw source data, normalizes and enriches it, correlates it with tenant software inventories, and exposes prioritized findings through a SaaS application and AI-assisted investigation layer.

The architecture should start simple and evolve only when requirements or measured bottlenecks justify additional complexity.

## Primary Components

```text
Users
  |
  v
Next.js Web
  |
  v
TypeScript API / Control Plane
  |
  +-------------------+
  |                   |
  v                   v
PostgreSQL         Event Stream
                       |
          +------------+-------------+
          |            |             |
          v            v             v
      Crawler       Pipeline     Intelligence
      Python        Python         Python
          |            |             |
          v            v             v
       S3 store    PostgreSQL     AI Models
                    / later
                  ClickHouse
```

### `apps/web`

Next.js SaaS interface.

Responsibilities:
- authentication UX
- organization/project navigation
- SBOM upload
- findings UI
- investigation UI
- audit/admin views

The web application should not contain core security or tenant-authorization logic.

### `apps/api`

TypeScript control plane.

Responsibilities:
- authenticated API surface
- organizations and memberships
- projects
- authorization
- upload coordination
- findings access
- investigation orchestration
- audit access
- tenant-aware domain services

Prefer stateless API instances so they can scale horizontally.

### `services/crawler`

Python data acquisition service.

Responsibilities:
- external API/source adapters
- rate limiting
- retries/backoff
- checkpointing
- fetching source data
- storing raw artifacts
- publishing ingestion events

Fetching should remain separate from normalization.

### `services/pipeline`

Python processing/ETL service.

Responsibilities:
- schema validation
- normalization
- enrichment
- deduplication
- correlation preparation
- replay/reprocessing
- loading normalized data

Consumers must tolerate duplicate delivery and be idempotent where practical.

### `services/intelligence`

Python AI and prediction layer.

Responsibilities:
- AI investigation workflows
- retrieval
- approved AI tools
- model/provider abstraction
- structured outputs
- evaluations
- future prediction models

Models must not receive unrestricted database access. Tenant-aware tools sit between the model and domain data.

## Initial Infrastructure

MVP infrastructure should remain small:

- PostgreSQL — operational state
- S3-compatible object storage (SeaweedFS locally; official MinIO images are no longer published) — raw and large object storage
- Redpanda/Kafka — asynchronous events
- Redis — caching/rate limiting only when justified
- OpenTelemetry — telemetry
- Grafana stack — local observability

Later additions such as ClickHouse, dbt, Kubernetes, and more specialized storage should be introduced because of demonstrated requirements, not preemptively.

## Communication Boundaries

TypeScript and Python services should communicate through explicit, versioned contracts.

Prefer:
- HTTP APIs for synchronous control-plane operations
- events for asynchronous ingestion/processing
- JSON Schema or another language-neutral schema format

Do not share implementation code across language boundaries.

Every distributed request/event should propagate useful identifiers such as:
- request/correlation ID
- tenant ID where applicable
- event ID
- source/job ID

## Multi-Tenancy

The organization is the primary tenant boundary.

Tenant scope must be enforced:
- at authenticated API boundaries
- in domain services
- in storage access
- in asynchronous jobs/events
- in AI tools
- in audit data

Never rely on the frontend or model to enforce tenant boundaries.

## Reliability Principles

Design for:
- duplicate event delivery
- retries
- partial failures
- timeouts
- worker crashes
- provider rate limits
- backpressure
- safe replay of raw data

Do not require a distributed transaction across services.

## Evolution

Sentra should evolve through evidence:

1. Build the simplest end-to-end path.
2. Instrument it.
3. Load test it.
4. Identify the bottleneck.
5. Change the architecture only where needed.
6. Measure again.

Major long-lived decisions should be recorded as ADRs.
