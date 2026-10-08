# Event contracts

Events are JSON documents on Kafka-API topics (Redpanda locally). Each has a versioned JSON Schema in [`events/`](events/). Conventions are recorded in [ADR 0002](../../docs/adr/0002-event-conventions-for-async-ingestion.md).

| Event | Schema | Purpose |
| --- | --- | --- |
| `crawl.requested` | [`crawl.requested.v1.json`](events/crawl.requested.v1.json) | Signed request to ingest one source + ecosystem |
| `artifact.ingested` | [`artifact.ingested.v1.json`](events/artifact.ingested.v1.json) | A raw artifact is stored and ready for normalization |
| `sbom.uploaded` | [`sbom.uploaded.v1.json`](events/sbom.uploaded.v1.json) | A tenant's SBOM upload was accepted and is ready for validation |
| `sbom.parsed` | [`sbom.parsed.v1.json`](events/sbom.parsed.v1.json) | An SBOM import was parsed; wakes correlation for its project |
| `vulnerabilities.normalized` | [`vulnerabilities.normalized.v1.json`](events/vulnerabilities.normalized.v1.json) | A raw artifact was normalized into the vulnerability tables |
| `crawl.failed` | [`crawl.failed.v1.json`](events/crawl.failed.v1.json) | A run failed permanently |

## Envelope

Every event has `eventId` (UUID), `type`, `version` (integer), `timestamp` (ISO 8601 UTC) and `correlationId` (same pattern as the logging contract). Field names are camelCase. Unknown fields are rejected (`additionalProperties: false`), so adding a field means a new version.

## Rules

- Delivery is at-least-once: consumers dedupe by `eventId` and must be idempotent.
- Events carry references (bucket, key, hash), never payloads, and never URLs for the consumer to fetch.
- A breaking change adds a new schema file (`...v2.json`); producers and consumers migrate explicitly.

## Signing `crawl.requested`

`signature` is the lowercase hex HMAC-SHA256, using the secret named by `keyId`, over the canonical JSON of the event without `signature`: keys sorted, no whitespace, UTF-8. Receivers accept any configured `keyId` so keys can overlap during rotation, and drop unsigned, mis-signed or unknown-key events without creating a run.
