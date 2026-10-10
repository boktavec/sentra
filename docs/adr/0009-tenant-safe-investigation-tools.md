# 0009: Investigation tools run behind an internal API listener with layered authentication

- Status: Accepted
- Date: 2026-10-09
- Amended by: [ADR 0011](0011-validated-structured-investigation-results.md): the internal listener also serves `POST /internal/v1/investigations/:id/complete`, and tool responses carry a `call` number.
- Related: [SENTRA-18 spec](../features/SENTRA-18-tenant-safe-ai-tools/spec.md), [ADR 0007](0007-durable-investigation-runs.md) (amended: the model no longer has "no tools"), [ADR 0008](0008-read-time-rule-based-risk-priority.md)

## Context

An investigation's model sees only a snapshot frozen at start. SENTRA-19 needs it to cite current project impact and public intelligence, and it must never invent facts that no tool provided. The model must still never touch the database, choose a tenant, or bypass application authorization. Priority, KEV and advisory-group logic already exists in TypeScript SQL (`finding-sql.ts`) and ADR 0008 keeps that as the single source of truth.

## Decision

- **Tools are typed, read-only endpoints on the API, not worker queries.** The Python worker's database role stays limited to investigation lifecycle rows, plus one new column (`attempt_deadline_at`). It has no grant on findings, SBOM dependencies, vulnerabilities, or the tool ledger.
- **A separate, non-public listener.** A second Fastify instance in the API process serves only `/internal/v1/*`, bound to `INVESTIGATION_TOOLS_HOST` (default loopback). The public listener never registers those paths and the internal one registers nothing else.
- **Two credentials on every call.**
  - A static service bearer secret (`INTELLIGENCE_TOOL_TOKEN`, at least 32 bytes), compared in constant time before any database access.
  - A per-run token `v1.<kid>.<b64url claims>.<b64url HMAC-SHA256>` over `{inv, lease, exp}`. The worker obtains it from a token-exchange endpoint by presenting the secret and its current lease owner. `exp` is the earlier of the lease expiry and the attempt deadline. Keys are a `kid` keyring (`INVESTIGATION_TOOL_SIGNING_KEYS`): the first signs, all verify, so rotation needs no downtime.
- **Authority comes from the run row, never the model.** Each call re-reads the investigation: it must be `running`, under the token's lease owner, with an unexpired lease and deadline. Org, project and finding are taken from that row. Argument schemas reject scope fields (`additionalProperties: false`).
- **Run-scoped authority (accepted limitation).** Membership is checked when the run starts, not on each call. A run keeps reading its own project's data after its creator is removed. That data reaches a draft visible to remaining members, never to the removed user. A test pins this behavior; per-call membership checks are the drop-in change if a security review requires revocation mid-run.
- **The API owns the evidence.** Every authenticated call and token exchange writes one `investigation_tool_calls` row (tool, outcome, attempt, round, duration, bounded result). The worker cannot skip or forge it. The API also enforces the per-attempt call cap from this ledger, serialized per run by an advisory lock, so the cap does not depend on the worker.
- **Contracts are files.** `packages/contracts/ai-tools/<tool>.v1.json` holds each tool's description, argument schema and result schema. The API validates arguments (the authority: the worker checks only the tool name and that arguments parse as an object) and results against them.
- **Bounded results, not errors.** Lists are trimmed and text fields capped deterministically; the call returns `ok` with `truncated: true`. A result that cannot be made to fit fails loudly rather than being sent.
- **Failure split.** Model-caused failures (`invalid_args`, `not_found`, call limit) return as typed 200 outcomes. Lost leases return `409 lease_lost`. Bad credentials return one indistinguishable `401 tool_unauthorized`. Anything unexpected is a safe `5xx`. The worker maps these to retry, terminal, or stop (PR 2).

## Alternatives considered

- Worker queries Postgres directly, with or without row-level security: fewer hops, but duplicates priority logic in Python, widens the worker's grants to tenant tables, and makes isolation depend on session settings the worker controls.
- SECURITY DEFINER functions: keeps logic in the database, but splits the priority source of truth between TypeScript and SQL functions.
- `/internal` prefix on the public listener: no new port, but one misrouted proxy rule exposes it. A separate listener makes exposure a deployment decision.
- Static secret alone: a leaked secret would then work against every run. mTLS: stronger identity, but certificate tooling is out of scope for the local-first stack.
- Per-call membership recheck (Q6 option A): tighter revocation, more per-call cost and complexity. Rejected by the user for now.
- Metadata-only ledger, or one `audit_events` row per call: too little evidence for SENTRA-19, or noise in the user-facing audit log.

## Consequences

- The API gains an internal port and required secrets; it and the worker refuse to start without them. A worker-to-API runtime dependency now exists: an API outage ends an attempt as retryable.
- **Same-trust minting.** Whoever holds the service secret and a current lease owner (the worker role can read it for every running row) can mint a run token. The per-run token limits replay window and blast radius; it does not remove the need to protect the secret.
- **Prompt injection can still mislead the draft.** Tool results are untrusted text. It cannot widen scope, call unknown tools, exceed caps, or write data. Draft quality belongs to SENTRA-19.
- The ledger stores a bounded private copy of tenant data under the same undefined retention as drafts. Retention needs a product decision before production data.
- Token exchange rows are not capped by the API (only tool calls are); only a holder of the service secret can create them.
- Rollout order is migrate, then the new worker, then the new API. The new worker serves both prompt versions and needs only the service secret to start, so no worker that ignores `prompt_version` sees a version 2 run on the way forward. Rolling back still needs the runbook in the spec before an old worker is started.
- Revisit when per-project permissions exist, when revocation must take effect mid-run, or when measured tool latency misses a target.
