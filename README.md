# Sentra

> A scalable, multi-tenant security intelligence platform for ingesting large datasets, analyzing software supply-chain risk, and powering AI-assisted investigations.

## Overview

Sentra is a production-oriented engineering lab for learning and implementing software architecture, distributed systems, data engineering, security engineering, AI engineering, platform and SRE practices, observability, scalability, and multi-tenancy. It is currently in its initial architecture and repository bootstrap phase. The capabilities below are plans, not implemented features.

## Product concept

The intended data flow is:

```text
External security/software data
        ↓
Python crawler
        ↓
Raw object storage
        ↓
Event stream
        ↓
Normalization / enrichment pipeline
        ↓
Operational + analytical storage
        ↓
AI intelligence layer
        ↓
API / SaaS application
```

Potential sources include OSV, CISA KEV, GitHub Security Advisories, npm and PyPI package ecosystems, repository metadata, and tenant-provided SBOMs or asset information. Source selection, licensing, data contracts, and ingestion methods remain to be decided.

## Planned architecture

| Area | Intended responsibility |
| --- | --- |
| `apps/web` | Next.js SaaS frontend |
| `apps/api` | TypeScript API and control plane |
| `services/crawler` | Python distributed crawler |
| `services/pipeline` | Python normalization, enrichment, deduplication, and ETL |
| `services/intelligence` | Python AI harness, retrieval, tools, agents, evaluation, and prediction |
| `packages/contracts` | Language-neutral API and event schemas |
| `packages/ts-sdk` | TypeScript SDK |
| `packages/py-sdk` | Python SDK |
| `warehouse` | ClickHouse storage and dbt analytical models |
| `infra` | Local and eventual production infrastructure |
| `loadtest` | k6 performance and scale testing |
| `docs` | Architecture decisions, threat models, scaling experiments, and engineering documentation |

## Planned technology stack

This is a **planned stack**, not an inventory of implemented or deployed software.

| Technology | Planned role |
| --- | --- |
| TypeScript | SaaS frontend, API, and SDK |
| Next.js | SaaS frontend framework |
| Python | Crawling, data pipeline, intelligence, and SDK |
| PostgreSQL | Operational data |
| pgvector | Initial vector storage and retrieval |
| Redis | Caching and selected transient workloads |
| Redpanda/Kafka | Event streaming |
| MinIO | Raw object storage |
| ClickHouse | Analytical warehouse |
| dbt | Analytical transformation and modeling |
| OpenTelemetry | Traces, metrics, and logs instrumentation |
| Grafana stack | Observability and dashboards |
| k6 | Load and performance testing |
| Docker | Initial local container environment |
| Kubernetes | Later orchestration option, if justified by scale and operations |

## Engineering principles

- Start simple and evolve from measured bottlenecks; avoid premature microservices and sharding.
- Use a monorepo initially while keeping services independently deployable.
- Keep API and event contracts language-neutral.
- Separate operational and analytical workloads.
- Preserve raw data so pipelines can be replayed.
- Design event consumers to tolerate duplicate delivery.
- Default to strong tenant isolation.
- Include observability in architecture and implementation decisions.
- Make architectural changes from evidence, including load tests and failure analysis.

## Scaling goals

Scale testing will progress through illustrative milestones of 10, 100, 1,000, 10,000, and 100,000 users, then larger simulated production workloads. An eventual 10M-user architecture and capacity exercise is a learning goal, not a current capacity claim.

Experiments should measure throughput; p50, p95, and p99 latency; error rate; CPU and memory; database connections; cache hit rate; queue lag; worker throughput; and storage throughput. Workload models and targets will be defined before drawing conclusions from those numbers.

## Security goals

Planned work includes authentication, authorization, RBAC, tenant isolation, audit logging, rate limiting, secrets management, encryption, secure AI tool boundaries, supply-chain security, and SOC 2-aligned engineering practices. No certification or compliance status is claimed.

## Project status

**Status: Initial architecture and repository bootstrap.**

No production functionality exists yet. The directories below reserve boundaries for future work; no applications, services, infrastructure, or data pipelines are implemented.

## Repository layout

```text
sentra/
├── apps/                 # SaaS frontend and API
│   ├── web/
│   └── api/
├── services/             # Data ingestion, processing, and intelligence
│   ├── crawler/
│   ├── pipeline/
│   └── intelligence/
├── packages/             # Shared contracts and SDKs
│   ├── contracts/
│   ├── ts-sdk/
│   └── py-sdk/
├── warehouse/            # Analytical storage and models
│   ├── clickhouse/
│   └── dbt/
├── infra/                # Local and future production infrastructure
│   ├── docker/
│   ├── kubernetes/
│   └── observability/
├── loadtest/             # Performance testing
│   └── k6/
├── docs/                 # Architecture, decisions, security, and scale
│   ├── architecture/
│   ├── adr/
│   ├── security/
│   └── scaling/
├── .editorconfig
├── .gitignore
├── LICENSE
└── README.md
```

Empty areas contain `.gitkeep` placeholders so Git preserves the intended structure.

## Development philosophy

AI coding agents may be used heavily during implementation. Architectural decisions, tradeoffs, failure modes, security boundaries, scalability assumptions, and verification remain deliberate engineering responsibilities. Changes should be reviewed against those responsibilities and measured where possible.

## Roadmap

1. **Phase 0 — Repository and engineering foundation**
2. **Phase 1 — End-to-end MVP**
3. **Phase 2 — Reliability and event-driven processing**
4. **Phase 3 — Multi-tenancy and security**
5. **Phase 4 — Observability and SLOs**
6. **Phase 5 — Warehouse and analytics**
7. **Phase 6 — AI investigations and prediction**
8. **Phase 7 — Performance, scale, and chaos testing**
9. **Phase 8 — Kubernetes and advanced scaling**

## License

MIT; see [LICENSE](LICENSE).
