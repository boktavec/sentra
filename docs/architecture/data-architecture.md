# Sentra Data Architecture

## Goals

The data platform should support:
- replayable ingestion
- GB-to-TB scale raw data
- normalized operational data
- historical analytics
- tenant isolation
- deterministic processing
- future AI/ML workloads

## Data Layers

### Raw Data — MinIO

Raw external and tenant-provided artifacts should be preserved before transformation.

Examples:
- OSV responses
- GitHub advisory payloads
- CISA KEV snapshots
- uploaded SBOMs

Raw data should be treated as immutable whenever practical.

Benefits:
- replay processing
- debugging
- schema migration
- provenance
- recovery from pipeline bugs

### Operational Data — PostgreSQL

PostgreSQL is the initial source of truth for application state.

Examples:
- users
- organizations
- memberships
- projects
- imports
- dependencies
- vulnerabilities
- findings
- investigations
- audit events
- ingestion job metadata

Postgres should serve current product state, not unlimited analytical workloads.

### Event Stream — Redpanda/Kafka

Events connect asynchronous stages.

Example event families:
- `crawl.requested`
- `crawl.completed`
- `artifact.ingested`
- `document.normalized`
- `correlation.requested`
- `finding.updated`
- `investigation.requested`

Events should include:
- event ID
- event type/version
- timestamp
- tenant ID when applicable
- correlation ID
- stable references to source artifacts

Consumers should assume at-least-once delivery.

### Analytical Warehouse — ClickHouse (Later)

ClickHouse should be introduced once historical analytical workloads justify it.

Potential warehouse data:
- vulnerability observations over time
- package activity
- risk score history
- ingestion metrics
- tenant usage metrics
- AI evaluation outcomes

dbt can later manage staging/intermediate/mart transformations.

Do not make ClickHouse a blocking MVP dependency.

## Pipeline Shape

```text
External Source
    |
    v
Fetch
    |
    v
Store Raw Artifact
    |
    v
Publish Event
    |
    v
Normalize
    |
    v
Deduplicate / Enrich
    |
    v
Operational Store
    |
    +--> Correlation
    |
    +--> Later Warehouse
```

## Data Modeling Principles

- Preserve source identifiers and provenance.
- Normalize provider-specific payloads behind adapters.
- Prefer stable internal identifiers.
- Avoid silently guessing when package/version identity is ambiguous.
- Make reprocessing idempotent.
- Treat schema evolution as expected.
- Keep tenant-scoped data explicitly tenant-scoped.
- Keep large binaries/raw payloads out of PostgreSQL when object storage is more appropriate.

## Future Scale Work

When data grows, investigate in order:
- indexes/query plans
- batching
- bulk ingestion
- table partitioning
- retention
- read replicas
- warehouse offloading
- tenant-aware sharding only when necessary
