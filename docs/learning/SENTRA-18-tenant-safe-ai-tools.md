# SENTRA-18: Tenant-safe AI investigation tools

## What was built

The investigation worker's model can now look things up instead of reasoning only over a frozen snapshot. It gets four read-only tools: the investigated finding's current risk, related findings in the same project, the finding's package occurrences in its SBOM import, and a public advisory lookup. The model never touches the database and never says whose data it is asking about.

- **API side:** a second, non-public Fastify listener (`/internal/v1/*`), a token-exchange endpoint, the four tool handlers, JSON Schema contracts, and an API-written ledger (`investigation_tool_calls`).
- **Worker side:** a bounded OpenAI-style tool-calling loop (prompt version 2), a small HTTP client for the listener, failure classification, lease renewal with an attempt deadline, and a drain branch for runs queued before the change.

## Why it is designed this way

- **Tools live in the API, not in the worker.** Priority and KEV logic already exists once, in TypeScript SQL (ADR 0008). Querying from Python would duplicate it and widen the worker's database grants to tenant tables. Now the worker role gains exactly one column.
- **Scope comes from the run row, never from the model.** Every call re-reads the investigation: it must be running, under the caller's lease, and org, project and finding are taken from that row. Tool schemas forbid extra properties, so a model that supplies `orgId` gets `invalid_args` and nothing is read. The model cannot ask for what it cannot name.
- **Two credentials.** A static service secret keeps the listener closed to anything but the worker. A short-lived per-run HMAC token limits a leaked or replayed credential to one run and the lease's lifetime. The honest caveat: whoever holds the secret and a lease owner can mint a token, so the token narrows blast radius but is not an independent root of trust.
- **The API writes the evidence.** Every call lands in a ledger the worker cannot write, and the API enforces the call cap from that ledger under a per-run advisory lock. SENTRA-19 can cite exact retrieved facts, and a misbehaving worker cannot skip or forge them.
- **Results are bounded, not rejected.** Oversized lists are trimmed and long text is cut, with `truncated: true`. The model can page with a cursor and a long advisory does not become a failure.
- **Run-scoped authority (accepted limitation).** Membership is checked when a run starts, not on every call. A removed creator's in-flight run can still read its own project, and the draft stays visible only to current members. The behavior is pinned by a test so a future change is deliberate.

## Alternatives considered

- Worker queries Postgres directly (with or without row-level security), or SECURITY DEFINER functions: fewer hops, but a second copy of priority logic or a wider worker role.
- Self-owned JSON tool protocol instead of native `tool_calls`: no dependence on the provider's parser, but a bespoke protocol to maintain. Native was chosen; if oMLX parsing proves unreliable, the fallback is that protocol, not silent JSON scraping.
- Mutual TLS, or the bearer secret alone: stronger identity, or simpler, respectively. Layered secret plus per-run token fit a local-first stack.
- Per-call membership recheck: tighter revocation, more cost per call. Rejected for now.

## Tradeoffs

- A worker-to-API runtime dependency: an API outage now ends an attempt as retryable `tool_unavailable`.
- A second private copy of tenant data (ledger results) under the same undefined retention as drafts.
- Prompt injection can still mislead the *wording* of a draft. It cannot widen scope, call unknown tools, exceed caps, or write data. Draft quality is SENTRA-19's evaluation.

## Scaling implications

Tool calls are small, project-scoped, indexed reads: at most 8 per attempt and 5 token exchanges, one run per model slot. With one global concurrent model call the API sees a trickle. Concurrency per run is serialized by an advisory lock, which holds a pool connection for the duration of a call (bounded by a 2 second statement timeout). If tool latency or ledger growth misses a target once measured, the first levers are the page and cap sizes and a retention policy for ledger results. All caps are provisional.

## Failure and security considerations

- Bad credentials, expired or other-run tokens and a missing bearer are one indistinguishable `401`; the bearer is checked before any database access.
- Lease and deadline are checked on every call, so a stale or re-claimed worker gets `409 lease_lost` and stops without writing.
- The worker classifies by cause: model-caused errors return to the model as fixed typed errors, infrastructure failures retry, security refusals stop. Raw API and provider text never reaches the model or the stored failure.
- Tool results enter the conversation only as `role: tool` messages marked untrusted; the system prompt is fixed and versioned.
- Roll out in this order: migrate, new worker, new API. The new worker handles both prompt versions and only needs the service secret to start, so the old single-call worker never meets a version 2 run going forward.
- Rolling back needs an operator step: the old worker ignores `prompt_version`, so version 2 runs must be failed first (`services/intelligence/runbooks/rollback-prompt-v2.sql`).
- Not yet verified against the real model: whether the served Qwen build returns parsed `tool_calls` and accepts a final turn without `tools`.

## Key concepts to understand

- **Confused-deputy defense:** the tool endpoint takes authority from state it owns (the run row), not from the caller's request.
- **Credential layering and blast radius:** a long-lived secret plus a short-lived, run-bound token.
- **Typed failure semantics:** deciding, per cause, whether a failure is the model's to fix, the system's to retry, or an operator's to see.
- **Untrusted retrieved content:** structural limits (scope, caps, validation) guarantee what the model can *do*; they do not guarantee what it *writes*.
- **Bounding agent loops:** rounds, calls, result sizes, and deadlines, each enforced where it cannot be skipped.
