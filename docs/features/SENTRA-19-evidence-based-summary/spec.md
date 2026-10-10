# SENTRA-19: Evidence-based investigation summary

- Status: Implemented (awaiting independent review); see "Implementation notes" for where the build refined this spec
- YouTrack: http://localhost:8080/issue/SENTRA-19
- Architecture decision: [ADR 0010](../../adr/0010-validated-structured-investigation-results.md) (structured result with API-side grounding); amends [ADR 0007](../../adr/0007-durable-investigation-runs.md) and [ADR 0009](../../adr/0009-tenant-safe-investigation-tools.md)
- Owner: Project member (user outcome); operational owners: API maintainers (validation, result store, routes) and intelligence worker maintainers (prompt, repair turn)

## Problem and outcome

SENTRA-18 lets the model look up project and intelligence data through tenant-safe tools, and the API records every call in `investigation_tool_calls`. The worker still stores one plain-text `draft` that no user API exposes and that nothing checks. A project member cannot see an explanation, cannot tell which statements come from retrieved data and which from the model, and nothing stops the model from restating facts wrongly.

Done means a project member opens a completed investigation and sees:
- a concise summary of the vulnerability and its impact on their project;
- retrieved facts and deterministic risk shown separately from the model's explanation;
- links to the finding and dependency evidence behind each statement;
- the known gaps and the model's stated uncertainty;
- a result that was validated by the API against the ledger before it was stored.

## Scope

- In scope:
  - A structured result schema (`packages/contracts/ai-tools/investigation-result.v1.json`).
  - Prompt version 3 and a worker repair turn.
  - A new internal `complete` endpoint on the SENTRA-18 listener that validates and persists the result.
  - Deterministic assembly of facts and gaps by the API.
  - A member-scoped result route and a web view in the existing investigations workspace.
  - Isolation, injection, grounding and failure tests; ADR; learning note.
- Out of scope:
  - An LLM judge or any second model pass; a draft-quality benchmark or eval harness.
  - Remediation steps beyond what the model writes inside the schema; write tools; new tools.
  - Retention policy for results, drafts and the ledger (open follow-up shared with SENTRA-17/18).
  - Backfilling or showing plain-text drafts from prompt version 1 and 2 runs.
  - Streaming, chat, or re-running an investigation from the result view.
- Dependencies and related stories: SENTRA-17 (run lifecycle, Done), SENTRA-18 (tools, ledger, internal listener, Done), SENTRA-14 (priority), SENTRA-16 (finding detail links), SENTRA-21 (isolation suite). SENTRA-20 (audit log) is unaffected.

## Decisions and alternatives

| # | Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- | --- |
| Q1 | Result shape | Structured JSON validated against a versioned schema; replaces `draft` for new runs | Plain text plus ledger-derived evidence list; Markdown with inline citation tags | Individual claims and evidence become checkable. Costs a schema, a migration and a failure path. |
| Q2 | Grounding | Schema plus citation check. Deterministic facts (priority tier, KEV, CVSS, purl, version) are filled by the API from ledger data and are never model-written. | Schema and citations only; add an LLM judge | Separates retrieved facts, deterministic risk and model explanation as the story asks. It cannot catch a wrong sentence that cites a valid call; that stays a measured limitation. |
| Q3 | Viewing | Member-scoped API plus web view in the existing workspace | API only; persistence only | Delivers the user outcome end to end. Larger change, so two stacked PRs. |
| Q4 | Uncertainty | Both: API-derived `gaps` plus a required model-written `uncertainties` field | Model-stated only; deterministic only | A forgetful model cannot hide a known gap, and gaps are testable without a live model. Adds a small rule table. |
| Q5 | Where validation runs | Worker POSTs the model JSON to an internal `complete` endpoint; the API validates, assembles and persists | Validate at read time; worker validates in memory | The API stays the single authority (as D1 in SENTRA-18) and the stored result is immutable. Adds one internal route; for v3 runs the worker no longer completes via SQL. |
| Q6 | Raw model I/O | Persist only the validated result, the snapshot and the ledger | Also keep rejected output; keep all raw output | Smallest privacy surface and no new retention debt. Costs debuggability; the violation category is logged, never the text. |
| Q7 | Evidence references | Model cites `call:<n>` (its own tool calls); the API stores resolved domain references and links to the finding detail page | Model cites domain ids directly; show raw call ids | The model cannot cite what it did not retrieve, and users get meaningful links. Ledger bodies stay private. |
| Q8 | Invalid output | One in-loop repair turn with a fixed typed violation list, then terminal `invalid_output` | Fail immediately and rely on attempt retries; fail terminal with no repair | Recovers cheaply from the likeliest local-model mistakes within existing caps. Needs one reserved round. |

Third-party facts and verification status:
- **Assumed:** Qwen 3.8:27b via oMLX produces schema-valid JSON with correct `call:<n>` references. Validation: run the worker against the live oMLX on at least 20 real investigations and record the first-pass and post-repair validity rates in the PR.
- **Assumed:** oMLX honors `response_format` / JSON mode. Validation: one curl probe in step 0 (not run by the implementer, which has no oMLX key; see "Implementation notes" for the command). The worker does not send `response_format`: the schema is in the prompt and the API validator is the authority, which is the stated fallback. Add `response_format` later only if the probe shows it helps the first-pass validity rate.
- **Verified in SENTRA-18 (2026-10-09):** the served model returns parsed `tool_calls`, accepts `role: tool` follow-ups, and answers in plain `content` when `tools` is omitted on the final round. It also added facts not present in a tool result, which is why facts are API-filled here.

## Architecture and contracts

### Flow

```text
Worker (Docker)                                   API process (host)
  claim run (SQL, ADR 0007); prompt_version = 3
  tool loop as in SENTRA-18 (<= 4 rounds, <= 8 calls)
  final round: tools omitted, model returns result JSON
  POST /internal/v1/investigations/:id/complete ---> bearer + run token + live lease
      {round, result}                                  validate against investigation-result.v1.json
                                                       check every call:<n> belongs to this investigation + attempt
                                                       assemble facts + gaps from ledger rows
                                                       persist result, set status completed (one transaction)
  <--- 200 {outcome: "ok"} | 200 {outcome: "invalid_result", violations: [codes]}
  invalid_result and no repair used yet: send typed violations as role:tool untrusted message, one more model turn
  invalid_result again: end attempt invalid_output (terminal, no result)
```

- The repair turn uses the reserved last round: tool rounds are capped at 3 for v3 so the answer round and the repair round both fit inside the existing 4-round budget and the 600 s attempt deadline. Cap values stay provisional configuration.
- `complete` is idempotent on `(investigation_id, attempt)`: a duplicate call after the run is already `completed` by that attempt returns `ok` without writing again; a call from a stale lease returns `409 lease_lost`.

### Result schema (`investigation-result.v1.json`)

Model-written (`additionalProperties: false`, string caps enforced):

| Field | Rule |
| --- | --- |
| `summary` | required, max 1200 chars, the vulnerability and why it matters |
| `tenantImpact` | required, max 1200 chars, impact on this project |
| `nextSteps` | 0 to 5 items, max 300 chars each |
| `claims[]` | 1 to 12 items: `{text (max 400), evidence: ["call:<n>", ...] (1 to 4)}`; every factual statement about the project or an advisory must be a claim |
| `uncertainties[]` | 0 to 6 items, max 300 chars each; may be empty only if `noUncertaintyReason` (max 300) is set |

API-written (the model cannot supply these; a model-supplied key is a schema violation):

| Field | Source |
| --- | --- |
| `facts` | finding id, purl, version, ecosystem, scope, status, match quality, lead advisory id, aliases, CVSS, KEV, priority tier and factors, taken from the `get_finding_risk` ledger row of this attempt (or the snapshot if absent) |
| `evidence[]` | resolved entries for each cited call: kind (`finding`, `dependency_occurrence`, `related_finding`, `advisory`), finding id, purl and version or advisory id, tool name, call number |
| `gaps[]` | codes derived by the rules below |
| `modelId`, `promptVersion`, `generatedAt` | run row |

Gap rules (each is a table-driven unit test): `advisory_not_found` (any `lookup_advisory` outcome `not_found`), `result_truncated` (any ledger result with `truncated: true`), `no_cvss`, `weak_match` (match quality below exact), `finding_resolved`, `no_tool_evidence` (zero ok calls), `related_findings_not_checked` / `occurrences_not_checked` (tool never called).

Citation rules, checked by the API: every cited `call:<n>` exists for this investigation and this attempt, has outcome `ok`, and is not a `token_exchange` row. A claim with no valid citation is a violation. Violation codes are fixed: `schema_invalid`, `unknown_evidence_ref`, `cross_attempt_ref`, `evidence_not_ok`, `uncited_claim`, `forbidden_field`, `missing_uncertainty_reason`.

### Storage (migration `017_investigation_results.sql`, additive)

- `investigation_results`: `investigation_id` (PK and FK), `org_id`, `project_id` (composite FK matching the run), `attempt`, `schema_version`, `result jsonb` (bounded at 32 KiB by CHECK), `created_at`. Written only by the API; no grant to `sentra_intelligence`. One row per run, immutable (no update path).
- Extend the existing `draft` / `status` CHECK so a v3 run reaches `completed` with a result row and a null `draft`. Legacy v1/v2 runs are unchanged.
- No new failure code is expected: `invalid_output` already exists. The implementer confirms against `014` and `016` and adds one only if a distinct operator signal is needed.

### API

- Internal: `POST /internal/v1/investigations/:id/complete`, same bearer, `X-Investigation-Token` and live-lease checks as the tool routes. Added to the SENTRA-21 internal-route coverage check.
- User: `GET /v1/orgs/:orgId/projects/:slug/findings/:findingId/investigations/:investigationId/result`, member-scoped by `scope(request, {orgId})`. Returns `404` (identical body) for another tenant, a missing run, or a run with no result. Queued, running and failed runs are read through the existing status route. The existing status and history routes keep hiding snapshot, draft and ledger.
- Responses never include ledger `args` or `result` bodies.

### Web

- The existing investigation page (`apps/web/src/app/orgs/[slug]/projects/[projectSlug]/investigations/`) renders, in order: `facts` and risk (labelled "From your project and security data"), the model explanation (`summary`, `tenantImpact`, `claims`, `nextSteps`; labelled "AI-generated explanation"), then `gaps` and `uncertainties`. Each claim lists its evidence as links to the finding detail page or the advisory id.
- States: queued, running, failed (existing safe codes), legacy run with no result ("No structured summary for this run"), completed.

### Compatibility and rollout

New runs are stamped `prompt_version = 3`. Order: migrate, deploy worker (handles 1, 2 and 3), then deploy API. Rollback: the previous worker would run v3 runs under the v2 path and write a plain draft, so stop the worker, redeploy the previous API, and fail queued or running v3 runs with the documented operator SQL (same runbook shape as ADR 0009).

## Implementation notes

Refinements made while building. None change an acceptance criterion; the ones that touch a contract are called out.

- **Call numbers.** `call:<n>` needed a stable number. The API assigns `investigation_tool_calls.call_no` (1-based per investigation and attempt, under the existing per-run advisory lock) and returns it as `call` on every `ok` tool response. The worker puts it in the tool envelope as `ref: "call:<n>"`; failed calls carry no ref. Migration `017` adds `call_no` and `truncated` to the ledger (the stored result alone cannot say whether a tool cut its output), and a partial unique index on `(investigation_id, attempt, call_no)`. This is an additive field on the tool response.
- **Round budget.** "Tool rounds capped at 3" could not hold five model turns inside four rounds. The built rule: tools are offered in rounds 1 to N-2, the answer is forced by round N-1, round N is the repair turn (N = `INTELLIGENCE_MAX_TOOL_ROUNDS`, default 4). The API's round range and the lease and deadline arithmetic are unchanged. With the default this is two tool rounds, which still allow up to 8 calls per attempt; tune from the 20-run measurement.
- **Repair message.** The repair turn is a `role: user` message built from fixed sentences keyed by violation code, not a `role: tool` message: OpenAI-style APIs require a tool message to answer an assistant `tool_calls` entry, and nothing a tenant or the model wrote is echoed back, so there is no untrusted content to envelope.
- **`uncited_claim` is reachable.** The schema allows up to 4 references per claim but no lower bound; the API rejects an empty list as `uncited_claim` so the model gets a specific reason. Every other claim rule is as specified.
- **Size guard.** The API-written parts are bounded by construction: at most 10 evidence targets across all cited calls, and an assembled part over 12 KiB is an API error (thrown, not blamed on the model). The stored result is then rejected as `schema_invalid` only if the model's own text pushes it over 28 KiB (the table's CHECK is 32 KiB of jsonb text, which spaces out keys and commas); only pathological multi-byte text reaches that.
- **Persistence.** `investigations_check` is replaced by two constraints: a draft exists only when `completed`, and a completed run has a draft unless `prompt_version >= 3`. No new failure code was needed (`invalid_output` already exists).
- **Completion guard.** The final `UPDATE` only completes a run that is still `running` under the presented lease; otherwise it throws `lease_lost` and the result `INSERT` rolls back, so a run swept or re-claimed while `complete` was in flight is never resurrected. Covered by a race test that holds the results table.
- **Gaps.** `related_findings_not_checked` and `occurrences_not_checked` count only successful calls. On the snapshot fallback, CVSS comes from the matching `linkedAdvisories` entry, so `no_cvss` is not forced.
- **Follow-up (advisory, not done).** A review noted a pre-existing pattern shared with SENTRA-18 handlers; tracked as a follow-up, not changed here.
- **Idempotency.** A repeat `complete` for a run that already has a result returns `ok` regardless of the lease owner presented, because the lease is cleared on completion. It writes nothing, and the caller learns nothing it did not already hold a valid run token for.
- **Metrics.** `investigation_repair_turns_total{outcome}` is emitted by the worker (Prometheus client); the two `investigation_result_*` counters by the API.
- **Step 0 and live measurement not run.** The implementer has no oMLX key. Run these yourself with the key from `infra/docker/.env` (do not paste it into the repo):
  `curl -s http://localhost:8000/v1/chat/completions -H "Authorization: Bearer $OMLX_API_KEY" -H 'Content-Type: application/json' -d '{"model":"Qwen 3.8:27b","max_tokens":200,"messages":[{"role":"user","content":"Reply with a JSON object with one key, ok, set to true."}],"response_format":{"type":"json_object"}}'`
  Record whether the reply is bare JSON (honored) or prose (ignored). The 20-run validity and duration measurement also needs the live model and stays open.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | **Unknown**, unchanged from SENTRA-17/18 | No measured demand | Existing start counters |
| Concurrent users or jobs | 1 global model job (existing default) | ADR 0007 configuration | Existing metrics |
| Data size and growth | One result row per run, at most 32 KiB | Derived from the CHECK bound | Table size after the local test |
| Latency or throughput target | **Unknown**. Added cost is one internal call plus at most one repair model turn per run. | Provisional caps | Run-duration histogram and rounds per run, p50/p95 recorded in the PR |
| Availability and recovery target | No SLO. API outage during `complete` ends the attempt `tool_unavailable` (retryable) under the existing attempts policy. | SENTRA-18 Q9 | Fault-injection test |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Model returns non-JSON or extra fields | `schema_invalid` or `forbidden_field`; one repair turn; then `invalid_output` | Stub-provider test |
| Model cites a call that does not exist, belongs to another attempt or investigation, or failed | `unknown_evidence_ref`, `cross_attempt_ref`, or `evidence_not_ok`; repair, then terminal | Integration test with a two-org, two-attempt fixture |
| Model states facts (severity, KEV) in prose that conflict with ledger data | Not blocked (accepted limitation); the facts panel shows the authoritative values next to the prose | Documented; covered by the grounding measurement |
| Injection text in an advisory summary or package name tries to change scope or format | Scope, schema and the citation check hold; text only reaches the model inside `role: tool` envelopes | Injection fixture plus a stub provider that obeys it |
| Required data missing (advisory unknown, results truncated, no CVSS, weak match, finding resolved) | Matching `gaps` are always present in the result | Table-driven gap tests |
| Model claims certainty with no uncertainties | Allowed only with `noUncertaintyReason`; otherwise `missing_uncertainty_reason` | Schema test |
| Worker crashes after `complete` succeeded | Retry finds a completed run and does not write a second result | Duplicate-complete test |
| Stale lease or run no longer running | `409 lease_lost`; nothing written | Lease-manipulation test |
| Provider fails or times out | Existing safe failure codes, no result | Existing tests, extended for v3 |
| Another org's member requests a result | Identical `404`; case added to the SENTRA-21 suite | Isolation suite |
| Creator removed mid-run | Unchanged from SENTRA-18 Q6; the result is visible only to current members | Existing pinned test, extended to the result route |
| Public listener receives `/internal/.../complete` | `404` | Test against the public app |

## Security, observability, and rollout

- Authorization and tenant isolation: the user route uses membership; the internal route needs the service secret, a run token and a live lease; org, project and finding come only from the run row; the model cannot supply scope or API-written fields; results and ledger bodies are not exposed through any other route.
- Model input and output handling (acceptance criterion 7): prompts, snapshots, model text and results are never logged and never metric labels. Logs carry correlation ID, investigation ID, org ID, outcome and violation code only. Rejected output is discarded. The stored result is the only new private copy, under the shared open retention follow-up.
- Metrics: `investigation_result_outcomes_total{outcome}` (`ok`, `invalid_result`, `lease_lost`), `investigation_result_violations_total{code}`, `investigation_repair_turns_total{outcome}`. No tenant labels.
- Rollout, migration, rollback: see Compatibility and rollout. Operational owner: API and worker maintainers.

## Acceptance criteria

- [ ] A completed investigation shows a concise summary of the vulnerability and tenant impact, stored as a validated structured result.
- [ ] The result references the tenant finding and dependency evidence it used, with working links to the finding detail page.
- [ ] Advisory intelligence (via `lookup_advisory` and the lead advisory) is part of the result facts or evidence.
- [ ] `gaps` always reflect missing data detected by the API, and the model-written `uncertainties` field is required.
- [ ] A result that cites a call the model did not make, or one that failed, is rejected and never stored; facts such as priority, KEV and CVSS come from ledger data, not model text.
- [ ] Results are persisted, immutable, and retrievable later by project members only; cross-tenant requests get an identical `404` and the new routes are in the SENTRA-21 suite.
- [ ] No prompts, model text, results or tokens appear in logs or metrics; rejected output is not stored.
- [ ] One repair turn recovers a violating answer; a second violation ends the run `invalid_output`.

## Verification

- Manual: against the live oMLX, start an investigation on a seeded finding and confirm the page shows facts, explanation, evidence links, gaps and uncertainties; run one finding with an unknown advisory and confirm `advisory_not_found`; capture Playwright screenshots under `docs/features/SENTRA-19-evidence-based-summary/screenshots/`.
- Automated: validator and gap-rule unit tests; stub-provider worker tests (valid, repair success, repair failure, injection obeyed); API integration tests (invented, cross-attempt and failed-call refs, duplicate complete, lease lost, two-org isolation, public listener 404); SENTRA-21 suite cases; web e2e. Then `task check`, `task test`, `task test:integration`, `task api:test:isolation`, `task intelligence:{lint,typecheck,test}`, `task fallow`.
- Measurement: first-pass and post-repair validity rate over at least 20 live runs, and run duration p50/p95, recorded in the PR.

## Open questions and assumptions to validate

- Confirm that any project member may view results (assumed, same as status and history routes). Resolve at spec review.
- `response_format` support in oMLX (step 0 probe). Resolve before the worker prompt is finalized.
- Result and ledger retention: tracked with SENTRA-17/18; not decided here.
- Whether 3 tool rounds plus an answer and a repair round is enough for the local model; tune from the 20-run measurement.
