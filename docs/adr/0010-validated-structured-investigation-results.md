# 0010: Investigation results are structured, validated by the API against the tool ledger, and stored immutably

- Status: Accepted
- Date: 2026-10-09
- Related: [SENTRA-19 spec](../features/SENTRA-19-evidence-based-summary/spec.md), [ADR 0007](0007-durable-investigation-runs.md) (amended: version 3 runs finish with a stored result, not a draft), [ADR 0009](0009-tenant-safe-investigation-tools.md) (amended: the internal listener gains a `complete` route)

## Context

After SENTRA-18 the model could look facts up, but it still wrote one plain-text draft that nothing checked and no user API exposed. A member could not tell which statements came from retrieved data and which from the model, and nothing stopped the model from stating a fact wrongly. The local model has been seen adding facts that were not in any tool result.

## Decision

- **The result is JSON, validated against a versioned contract.** `packages/contracts/ai-tools/investigation-result.v1.json` defines the model-written part: `summary`, `tenantImpact`, `nextSteps`, `claims[]` (text plus `call:<n>` evidence), `uncertainties[]` and an optional `noUncertaintyReason`. The worker embeds the same schema in its prompt.
- **The API assembles everything that is a fact.** Finding identity, advisory, CVSS, KEV, priority, the resolved evidence entries and the `gaps` list are derived from this attempt's tool-call ledger rows by the API. A model that supplies one of those fields is rejected (`forbidden_field`), so it cannot state or contradict a retrieved fact in a field the reader trusts.
- **Citations are checked, not trusted.** Each `call:<n>` must be a numbered call of this investigation and attempt with outcome `ok`. The API numbers calls itself (`investigation_tool_calls.call_no`) and returns the number with every successful tool response, so the model cites what it was given and cannot name another run's or another tenant's rows. Token exchanges are never numbered.
- **Validation happens where the data is.** The worker POSTs the parsed answer to `POST /internal/v1/investigations/:id/complete` (same two credentials and live-lease check as the tools). In one transaction, serialized per run by the existing advisory lock, the API validates, inserts the immutable `investigation_results` row and completes the run. The worker role has no grant on the result table.
- **One repair turn.** On `invalid_result` the worker sends a fixed-wording message built from the violation codes and asks once more. A second violation ends the attempt `invalid_output` (terminal). Rejected output is discarded, never stored or logged.
- **Round budget.** The existing four-round budget holds: tools are offered in rounds 1 to N-2, the answer is forced by round N-1, and round N is reserved for the repair.
- **Reads.** `GET .../investigations/:investigationId/result`, member-scoped, returns the stored result; a missing, legacy (draft-only) or other-tenant run is one identical `404`. Ledger bodies are never returned.
- **Schema change for the new shape.** A prompt version 3 run completes with a result row and a null `draft`; earlier versions still require a draft (two CHECK constraints replace one). The ledger gains `call_no` and `truncated`, because the stored tool result alone cannot say whether it was cut.

## Alternatives considered

- Plain text plus a ledger-derived evidence list: simpler, but individual statements cannot be checked and the reader cannot separate facts from prose.
- Model cites domain ids directly: the model could name data it never retrieved; resolving ids afterwards would need the same ledger lookup and invite cross-tenant probing.
- Validate at read time, or in the worker: the stored result could then be invalid or unverified, and the worker (not the authority on evidence) would decide.
- An LLM judge or second pass: costs a model slot and adds a non-deterministic reviewer; out of scope until measurements show a need.
- Persist rejected output for debugging: larger private-data surface and new retention debt. The violation code is logged instead.

## Consequences

- **Accepted limitation:** a claim can cite a valid, ok call and still say something the call does not support. The API cannot catch a wrong sentence with a valid citation. The facts panel shows the authoritative values beside the prose, and the grounding rate is measured rather than assumed.
- The stored result is another private copy of tenant data under the same open retention follow-up as drafts and the ledger.
- `complete` is idempotent on the run: a repeat after success (worker crash after commit) writes nothing. A stale lease gets `409 lease_lost`.
- A v3 run needs the new worker. Rolling back needs `services/intelligence/runbooks/rollback-prompt-v3.sql` before the previous worker starts, because the previous worker would run the run on the plain-draft path.
- Rollout order: migrate, new worker (handles versions 1 to 3), then the new API (stamps version 3).
- Revisit when measured first-pass validity or the repair rate is poor, when a user needs to see why a result was rejected (this decision keeps no rejected output), or when result retention is decided.
