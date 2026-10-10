# Investigation tool contracts

The intelligence worker gives its model four read-only tools. They are served by the API's internal listener ([ADR 0009](../../docs/adr/0009-tenant-safe-investigation-tools.md)); the model never reaches the database. Each tool has one versioned file in [`ai-tools/`](ai-tools/) holding its `description`, an `arguments` JSON Schema and a `result` JSON Schema. The API validates against these files, and the worker builds the model's tool list from them. A breaking change adds a `...v2.json`.

| Tool | Scope | Arguments |
| --- | --- | --- |
| [`get_finding_risk`](ai-tools/get_finding_risk.v1.json) | the investigated finding | none |
| [`list_related_findings`](ai-tools/list_related_findings.v1.json) | the investigation's project | `relation`, optional `limit` (1 to 10), `cursor` |
| [`get_dependency_occurrences`](ai-tools/get_dependency_occurrences.v1.json) | the finding's own SBOM import | none |
| [`lookup_advisory`](ai-tools/lookup_advisory.v1.json) | global intelligence, no tenant data | `id` |

Argument schemas set `additionalProperties: false`, so a model that supplies `orgId`, `projectId` or `findingId` gets `invalid_args` and nothing is read. Org, project and finding always come from the investigation row.

## Listener

Separate Fastify instance, default `127.0.0.1:4001` (`INVESTIGATION_TOOLS_HOST`, `INVESTIGATION_TOOLS_PORT`). It serves only the routes below; the public listener answers `404` for `/internal/*`.

Every request carries `Authorization: Bearer <INTELLIGENCE_TOOL_TOKEN>` and `X-Correlation-Id: <investigationId>.<attempt>`. A missing or wrong bearer is `401` before any database access. Errors use [`error-response.md`](error-response.md).

| Route | Request | Success |
| --- | --- | --- |
| `POST /internal/v1/investigations/:id/token` | `{leaseOwner}` | `200 {token, expiresAt}`; `expiresAt` is the earlier of the lease expiry and the attempt deadline |
| `POST /internal/v1/investigations/:id/tools/:tool` | header `X-Investigation-Token`, body `{round: 1..4, args: object}` | `200 {outcome: "ok", call, data, truncated}` |
| `POST /internal/v1/investigations/:id/complete` | header `X-Investigation-Token`, body `{round: 1..4, result: <the model's JSON>}` | `200 {outcome: "ok"}` or `200 {outcome: "invalid_result", violations: [code]}` |

Token format: `v1.<kid>.<base64url JSON {inv, lease, exp}>.<base64url HMAC-SHA256>`, signed with the first key of `INVESTIGATION_TOOL_SIGNING_KEYS` (`kid:base64key[,kid:base64key]`); every listed key verifies. Both secrets must be at least 32 bytes.

| Status and code | Meaning |
| --- | --- |
| `200`, `outcome: "ok"` | `data` matches the tool's `result` schema; `truncated` says whether anything was cut |
| `200`, `outcome: "invalid_result"` (`complete` only) | The answer failed validation; nothing was stored and the run is still running. `violations` is a list of the fixed codes below |
| `200`, `outcome: "invalid_args"`, `"not_found"`, `"call_limit_reached"` (outcome `limit`) | Model-caused. Body `{outcome, error: {code}}`; the model may retry |
| `400 invalid_input` | Malformed envelope (worker bug) |
| `401 tool_unauthorized` | Bad secret, or a missing, forged, expired, unknown-`kid` or other-run token. All indistinguishable |
| `404 not_found` | Unknown tool name |
| `409 lease_lost` | Run is not `running`, the lease owner differs, or the lease or attempt deadline has passed |
| `5xx internal_error` | Infrastructure failure; the worker treats it as retryable `tool_unavailable` |

Limits (provisional, tune from measurements): 8 tool calls per attempt, enforced by the API from the ledger; 8 KiB per result; 1 KiB per text field; 10 items per related-findings page; 20 dependency occurrences; 10 aliases; 2 s statement timeout.

`call` is the number the model cites as `call:<n>`: 1-based per investigation and attempt, assigned by the API when it records the call, and present only on `ok` responses. Token exchanges are never numbered.

Every authenticated call and token exchange is recorded in `investigation_tool_calls` by the API. Rejected requests (bad credentials, lost lease) are counted in `investigation_tool_auth_rejections_total{reason}` but write no row.

## Investigation result ([`investigation-result.v1.json`](ai-tools/investigation-result.v1.json))

The contract holds the JSON Schema of the part the model writes (`model`) and the list of fields only the API may write (`apiWrittenFields`). It is not a tool.

Model-written: `summary`, `tenantImpact`, `nextSteps` (0 to 5), `claims` (1 to 12, each `{text, evidence: ["call:<n>", ...]}`, at most 4 references), `uncertainties` (0 to 6) and, when `uncertainties` is empty, `noUncertaintyReason`. A claim with no references is rejected by the API as `uncited_claim`, not by the schema, so the model hears a specific reason.

API-written and stored next to them: `facts` (finding, advisory, CVSS, KEV, priority; from the `get_finding_risk` ledger row of the attempt, else the creation snapshot, flagged `source: "snapshot"`), `evidence` (one entry per cited call: `finding`, `related_finding`, `dependency_occurrence` or `advisory`, with finding ids and purls or the advisory id), `gaps`, `modelId`, `promptVersion` and `generatedAt`. Ledger `args` and result bodies are never part of it.

| Violation code | Meaning |
| --- | --- |
| `schema_invalid` | Not an object matching the schema, or the stored result would exceed its size cap |
| `forbidden_field` | The model supplied an API-written field |
| `unknown_evidence_ref` | A cited number is not a numbered call of this investigation |
| `cross_attempt_ref` | The number exists only in an earlier attempt |
| `evidence_not_ok` | The cited call did not succeed |
| `uncited_claim` | A claim lists no evidence |
| `missing_uncertainty_reason` | No uncertainties and no `noUncertaintyReason` |

| Gap code | Derived when |
| --- | --- |
| `advisory_not_found` | any `lookup_advisory` call returned `not_found` |
| `result_truncated` | any call of the attempt reported `truncated` |
| `no_cvss` | the advisory has no CVSS score |
| `weak_match` | the match quality is not `confirmed` |
| `finding_resolved` | the finding was resolved when it was read |
| `no_tool_evidence` | no call of the attempt succeeded |
| `related_findings_not_checked`, `occurrences_not_checked` | the tool was never called in the attempt |

`complete` is idempotent: after the run is completed a repeat returns `ok` and writes nothing; a stale lease is `409 lease_lost`. Only runs stamped `prompt_version >= 3` may complete this way (`400` otherwise). The member-facing read is `GET /v1/orgs/:orgId/projects/:slug/findings/:findingId/investigations/:investigationId/result`: one identical `404` for another tenant, a missing run, or a run with no result.

## Rollout order

Migrate, then deploy the new worker (it needs only `INTELLIGENCE_TOOL_TOKEN` and serves prompt versions 1 to 3), then the new API (listener, secret, signing keys; new runs are stamped `prompt_version = 3`, which SENTRA-18 stamped as 2).

## Local setup

The API refuses to start without these. Put the same `INTELLIGENCE_TOOL_TOKEN` in `infra/docker/.env.sentra` (API) and, once the worker uses it, `infra/docker/.env` (worker):

```sh
echo "INTELLIGENCE_TOOL_TOKEN=$(openssl rand -base64 32)" >> infra/docker/.env.sentra
echo "INVESTIGATION_TOOL_SIGNING_KEYS=k1:$(openssl rand -base64 32)" >> infra/docker/.env.sentra
```

`task stack:bootstrap` rewrites `.env.sentra`. It keeps `INTELLIGENCE_TOOL_TOKEN` (taken from `.env` when set there, otherwise from the previous file), keeps existing signing keys, and generates any that are missing, so a re-bootstrap does not stop the API from starting. When it generates a token it also appends it to `.env` for the worker.

Rotating a signing key: add the new key second, deploy, swap the order, deploy, remove the old key.
