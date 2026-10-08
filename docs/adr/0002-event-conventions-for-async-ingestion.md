# 0002: Event conventions for asynchronous ingestion

- Status: Proposed
- Date: 2026-10-07
- Related: [SENTRA-7 spec](../features/SENTRA-7-ingest-osv/spec.md)

## Context

SENTRA-7 is the first story to put events on a broker. SENTRA-8, 9, 10 and 11 will produce and consume the same kinds of events, so the conventions set here become the platform pattern.

## Decision

- **Broker:** Redpanda locally, accessed only through the standard Kafka client API so Apache Kafka or a managed service can replace it by config.
- **Delivery:** at-least-once. Producers publish only after the artifact is durably stored. Consumers are idempotent and dedupe by `event_id`.
- **Envelope:** every event carries `event_id`, `type`, `version`, `timestamp`, `correlation_id`, plus stable references to artifacts, never payloads or URLs to fetch.
- **Contracts:** versioned JSON Schema files in `packages/contracts/events/`. Consumers validate inbound events and producers are contract-tested. A breaking change means a new version.
- **Requests are signed:** command-style events (`crawl.requested`) are HMAC-SHA256 signed with a `key_id` so keys can overlap during rotation.
- **Run identity:** the requester assigns a `run_id`. Consumers insert it idempotently, so redelivery maps to the same run.
- **Failure:** exhausted retries record a failed state and publish a failure event, then commit the offset so a poison message cannot block a partition. A retry is a new request.

## Alternatives considered

- Postgres polling or a transactional outbox: simpler or safer handoff, but diverges from the documented event architecture or adds a relay to operate.
- Apache Kafka locally: transferable, but a heavier JVM process in compose.
- Pydantic-only or Avro/Protobuf with a registry: easier in Python only, or heavier tooling than three events justify.
- Ed25519 or per-publisher keys: stronger separation, but key-management cost before a threat requires it.

## Consequences

- A new schema, signing and idempotency discipline for every event family.
- A verifier that holds the shared secret can also forge requests; acceptable for one team.
- Crash between store and publish is recovered by redelivery or the next request, not instantly.
- **Revisit triggers:** a second team or untrusted publisher (move to asymmetric signing), a stuck-run delay that matters (add a sweep), or schema-evolution pain (consider a registry).
