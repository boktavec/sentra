# SENTRA-18: Tenant-safe AI investigation tools

- Status: Approved. Implemented in two stacked PRs: PR 1 (API, steps 1 to 5) and PR 2 (worker, wiring, docs, steps 6 to 9). Step 0 oMLX probes Verified 2026-10-09 (see Context)
- YouTrack: http://localhost:8080/issue/SENTRA-18
- Architecture decision: ADR 0009 (planned deliverable, see Implementation plan step 1); amends the "model receives ... no tools" bullet of [ADR 0007](../../adr/0007-durable-investigation-runs.md)
- Owner: Project member (user outcome); operational owners: API maintainers (tool listener, ledger, authorization) and intelligence worker maintainers (harness loop)

## Problem and outcome

SENTRA-17 gives every investigation a durable run, but the model sees only a snapshot frozen at start and cannot look anything up. SENTRA-19 needs the model to cite current project impact and trusted security intelligence, and the story requires that it never invent facts "not available through tools". The model must still never touch the database, choose a tenant, or bypass application authorization.

Done means:
- The worker runs a bounded, native tool-calling loop against oMLX.
- Each tool call goes to typed, read-only tool endpoints on a separate, non-public API listener.
- The listener authenticates the worker with two layers: a service secret and a per-run signed token.
- It derives organization and project only from the running investigation row, reuses the existing finding SQL and priority logic, and records every authenticated call in an API-written ledger.
- Cross-tenant and injection tests prove the boundary holds whatever the model emits.

## Scope

- In scope:
  - Four read-only tools: `get_finding_risk`, `list_related_findings`, `get_dependency_occurrences` (project-scoped), and `lookup_advisory` (global intelligence).
  - A separate internal Fastify listener in the API process, with layered authentication (static service bearer secret plus a per-run HMAC token issued by a token-exchange endpoint).
  - An `investigation_tool_calls` ledger written only by the API, with bounded private result bodies.
  - Worker harness: a native OpenAI-style `tools` loop with round, call, size, and deadline bounds; lease renewal; failure classification; prompt version 2. A temporary v1 branch drains runs queued before deploy.
  - Migration: ledger table, `attempt_deadline_at` column, new failure codes, and a worker grant on the new column only.
  - Tool JSON Schemas in `packages/contracts/ai-tools/`.
  - Isolation, authentication, injection, and failure-classification tests. The SENTRA-21 coverage check is extended to internal routes.
  - ADR 0009 and a learning note.
- Out of scope:
  - A user-facing summary, evidence citations in the UI, or exposing drafts or ledger rows through user APIs (SENTRA-19).
  - Write or remediation tools, org-wide (cross-project) tools, retrieval/RAG, embeddings, and additional model providers.
  - Prompt-injection sanitization or classifier models (Q10). Draft-quality evaluation (SENTRA-19).
  - mTLS, a secrets manager, or automatic key rotation tooling.
  - A retention policy for drafts and ledger results. This is tracked as an open question and shared with SENTRA-17's draft retention gap.
  - Per-call re-checking of the creator's membership (explicitly rejected in Q6; see Accepted limitations).
- Dependencies and related stories:
  - Depends on SENTRA-3 (Done, membership) and SENTRA-13 (Done, findings).
  - Builds on SENTRA-17 (run lifecycle, ADR 0007), SENTRA-14 (priority, ADR 0008), and SENTRA-12 (advisory groups).
  - Extends SENTRA-21 (isolation suite). Feeds SENTRA-19 (evidence-based summary).
  - SENTRA-20 (audit log) is unaffected: tool calls are not written to `audit_events`.

## Decisions and alternatives

| # | Decision | Chosen approach (user decision) | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- | --- |
| Q1 | Data beyond the snapshot | B: a small fixed set of read-only tools bound to the investigation's tenant and project | A snapshot-only accessors; C global intelligence only; D broader scope | Meets "scoped to the investigation tenant" and gives SENTRA-19 real evidence. It costs a scoped data path and per-tool isolation tests. |
| Q2 | First tool set | A: all four tools, project-scoped | B tools 1 and 4 only; C org-wide related/occurrence tools | Smallest set that shows in-project impact plus external intelligence. Org-wide scope would break the project-bound run boundary; widening it later is additive. |
| Q3 | How tools reach data | A: internal tool endpoints on the TypeScript API that reuse `findingSql()` and `toPriority()`. The worker's DB role is unchanged except for one column. | B worker queries Postgres directly (with or without RLS); C SECURITY DEFINER functions; D precompute at start | Keeps ADR 0008's single TypeScript source of truth for priority and keeps the worker's grants narrow. It adds an internal port, secrets, and a worker-to-API runtime dependency. Recorded as ADR 0009. |
| Q4 | Tool-use mechanism | A: native OpenAI-style `tools` / `tool_calls`, in a bounded loop | B self-owned JSON protocol; C native with JSON fallback; D single-shot plan-then-answer | Provider-standard contract that is easy to test with a stub server. It depends on oMLX parsing Qwen tool calls (**Assumed**, verified in step 0). If parsing proves unreliable, runs fail safely and we revisit with B, not C. |
| Q5 | Auditability of tool calls | A: an `investigation_tool_calls` ledger written by the API, with bounded private result bodies. No worker grant on it. Metrics and logs carry only tool name and outcome. | B metadata only; C one `audit_events` row per call; D logs and metrics only | The worker cannot skip or forge the ledger, and the ledger is exact evidence for SENTRA-19. It creates a second private copy of tenant data under the same undefined retention as drafts. |
| Q6 | Whose authority a tool call runs under | B: run-scoped authority. Authorization happens at start, and the run may read its project's data until it finishes, regardless of later membership changes. | A recheck the creator's membership on every call (recommended by the planner); C A plus finding-resolved refusal | User decision. Simplest per-call path. **Accepted limitation:** a removed creator's in-flight run can still pull current project data into a draft that remaining members can see. That data never reaches the removed user. Every call still enforces running state, the lease, and project scope taken from the row. The behavior is pinned by a test. |
| Q7 | Worker authentication to the tool listener | A + C layered: separate non-public listener with a static shared bearer secret, **and** a short-lived per-run HMAC token over `{investigationId, leaseOwner, exp}` | A alone; B mTLS; C alone; D `/internal` prefix on the public listener | User decision. A leaked bearer secret alone is useless without a current run token, and a run token is limited to one run and expires quickly. Cost: a signing keyring, a mint path, and rotation. Caveat: minting trusts secret plus lease, so C limits how long and how widely a captured credential works but is not an independent root of trust. |
| Q8 | Delivering the per-run token | A: a token-exchange endpoint on the internal listener. The worker keeps claiming via SQL (ADR 0007), then exchanges secret plus `leaseOwner` for a token with `exp = min(lease_expires_at, attempt_deadline_at)`. It re-requests after each lease renewal. | B move claiming into the API; C mint inside Postgres with `pgcrypto` | Signing key stays only in the API, and the proven claim and retry path is untouched. Costs one internal call per claim or renewal. |
| Q9 | Tool failure semantics | A: split by cause. Model-caused failures return to the model as fixed typed errors. Infrastructure failures end the attempt as retryable with `tool_unavailable`. Security failures end the attempt terminally with `tool_unauthorized`, or the worker stops on `lease_lost`. No draft is written. | B every tool failure ends the attempt; C every failure goes back to the model | The model can cheaply fix its own argument errors. Outages reuse the retry policy. Security refusals stop work and surface to operators. |
| Q10 | Untrusted retrieved content | A: structural defenses plus adversarial tests: `role: tool` untrusted envelope; fixed, versioned system prompt; strict argument validation; scope from the row; caps; injection fixtures | B plus sanitization; C plus injection classifier | Guarantees what the model *can do*, not what it *writes*. Draft quality and factuality belong to SENTRA-19 evaluation. |
| Q11 | Rollout and compatibility | A: replace the no-tool path, with the mode pinned per run (`prompt_version = 2`). A temporary v1 drain branch serves runs queued before deploy. Listener and secrets are required config. Order: migrate, then new worker, then new API (user decision, see Rollout). | B permanent flag with both paths; C hard cutover without pinning | One long-term path; every draft is attributable to the harness that produced it. Costs a short-lived drain branch and a rollback runbook step (see Rollout). |
| D1 | Argument validation authority | The API validates arguments against the contract schema and is authoritative. The worker only checks that the tool name is known and the arguments parse as a JSON object. | Full validation in both languages (adds a Python `jsonschema` dependency) | One validator, with no new Python dependency. Invalid arguments still come back as `invalid_args`. Planner proposal, confirm in review. |
| D2 | Oversized tool results | The API truncates deterministically: lists are trimmed and text fields are capped. It returns `ok` with `truncated: true` and does not return an error. | A `result_truncated` error | Refines the Q9 list: truncation is not a failure, and the model can page with `cursor`. Planner proposal, confirm in review. |
| D3 | Final round | On the last allowed round the harness omits `tools`, so the model must answer. If it still emits a tool call, the run fails with `invalid_output`. | Fail with a new `tool_budget_exhausted` code | No new code. Whether oMLX/Qwen behaves correctly without `tools` after tool messages is **Assumed** and is verified in step 0. |

### Accepted limitations

- **Run-scoped authority (Q6).**
  - Behavior: if the creator, or any member, loses membership while a run is queued or running, the run keeps calling tools until it finishes. It reads current data for the investigation's project only. The resulting draft and ledger stay visible only to current members through future SENTRA-19 surfaces, never to the removed user.
  - Pinned by: `investigation-tools.integration.test.ts`, "tool calls continue after creator membership removal and remain project-bound".
  - Revisit if: project-level permissions are introduced, or a security review requires revocation to take effect mid-run (Q6 option A is the drop-in change).
- **Same-trust minting (Q7/Q8).** Anyone holding the service secret and a current lease token, which the worker's DB role can read for every running row, can mint a run token. The per-run token limits replay window and blast radius. It does not remove the need to protect the service secret.
- **Prompt injection can still mislead the draft (Q10).** It cannot widen scope, call unknown tools, exceed caps, or write data.

### Third-party facts and verification status

- **Verified (Context7 `/jundot/omlx`, README, 2026-10-09):** oMLX documents tool calling through the chat-completions `tools` parameter when the model's chat template supports it. It auto-detects Qwen-family formats (JSON `<tool_call>`, and XML `<function=...>` for the Qwen3.5 series) and returns structured `tool_calls`. Source: https://github.com/jundot/omlx/blob/main/README.md. This is documentation only.
- **Verified (2026-10-09, user ran curl probes against the running oMLX with the key in their own shell; the key never entered an agent session or the repo):**
  - The served `Qwen 3.8:27b` returns parsed `message.tool_calls` (`lookup_advisory`, `{"id": "CVE-2021-44228"}`) with `finish_reason: "tool_calls"` for a schema like ours. The message carries `reasoning_content` and no `content`.
  - It accepts a follow-up `role: tool` message with the matching `tool_call_id` (with `tools` still present) and answers in plain `content` with `finish_reason: "stop"`.
  - It answers in plain `content`, with no `tool_calls`, when `tools` is omitted after tool messages (the final-round case). `reasoning_content` is also returned; the worker reads only `content`.
  - Observation for SENTRA-19: in the no-tools probe the model added facts that were not in the tool result (severity "critical", "Apache Log4j", attack description). Tool-grounded answers are not guaranteed by the harness; draft quality and grounding belong to SENTRA-19 evaluation.
- **Assumed (validate in step 0):** the Dockerized worker can reach an API listener bound to host loopback through `host.docker.internal` on Docker Desktop for macOS. SENTRA-17 **verified** this host name for oMLX on port 8000, but not for a loopback-only bind. If it fails, bind the listener to the address Docker Desktop forwards to and keep it off any public interface. Record which applies.
- Repository facts (inspected 2026-10-09, not third-party):
  - `sentra_intelligence` has SELECT on `investigations` and UPDATE on lifecycle columns only.
  - `findingSql()` / `toPriority()` live in `apps/api/src/finding-sql.ts`.
  - The SENTRA-21 coverage check only inspects `/v1/` routes on the public app.
  - `findings.import_id` identifies the SBOM import that produced the finding.

## Architecture and contracts

### Components and flow

```text
Worker (Docker)                          API process (host)
  claim run via SQL (ADR 0007), set attempt_deadline_at
  POST /internal/v1/investigations/:id/token ----------> internal listener (separate Fastify instance)
      Authorization: Bearer <service secret>               check bearer (constant time)
      body {leaseOwner}                                     row: status=running, lease_owner match, lease unexpired
  <---------------------------------------------- token    sign {inv, lease, exp, kid} with current key
  loop (<= 4 rounds, <= 8 tool calls):
    renew lease, re-exchange token
    oMLX /v1/chat/completions with tools ------------> oMLX (host)
    for each tool_call:
      POST /internal/v1/investigations/:id/tools/:tool -> verify bearer + token + live row
          {args, round}                                      org/project/finding FROM ROW ONLY
                                                             validate args (contract schema, no extra props)
                                                             findingSql()/toPriority() or advisory SQL
                                                             truncate, write ledger row, return typed result
      append role:tool untrusted envelope
  final answer -> complete(run, draft) as today
```

- The public listener never registers `/internal/*`, and the internal listener registers only `/internal/v1/*`. Each has its own 404 for everything else.
- The internal listener runs in the same process as the API and the relays, shares the pool and logger, and closes gracefully alongside them.

### Configuration (new, required for the API and worker to start)

| Variable | Component | Default | Rule |
| --- | --- | --- | --- |
| `INVESTIGATION_TOOLS_HOST` / `INVESTIGATION_TOOLS_PORT` | API | `127.0.0.1` / `4001` | Never `0.0.0.0` on a shared network. Step 0 decides the local bind. |
| `INTELLIGENCE_TOOL_TOKEN` | API and worker | none | Required, at least 32 bytes. The API and worker refuse to start without it. Never logged. |
| `INVESTIGATION_TOOL_SIGNING_KEYS` | API only | none | `kid:base64key[,kid:base64key]`. The first key signs; all listed keys verify. Each key is at least 32 bytes. Rotation: add the new key second, roll, swap order, roll, remove the old key. |
| `INTELLIGENCE_TOOLS_URL` | worker | `http://host.docker.internal:4001/internal/v1` | |
| `INTELLIGENCE_MAX_TOOL_ROUNDS` / `INTELLIGENCE_MAX_TOOL_CALLS` | worker (API enforces the call cap too) | 4 / 8 | Provisional |
| `INTELLIGENCE_TOOL_TIMEOUT_SECONDS` | worker | 5 | Provisional |
| `INTELLIGENCE_ATTEMPT_DEADLINE_SECONDS` | worker | 600 | Provisional |

At startup the worker validates `lease_seconds > model_timeout_seconds + max_tool_calls * tool_timeout_seconds` (180 > 90 + 40 by default), extending the existing lease invariant check. Each lease renewal sets `lease_expires_at = min(now + lease_seconds, attempt_deadline_at)`.

### Internal HTTP contract

Every request:
- carries `Authorization: Bearer <service secret>`; a missing or invalid secret returns `401` with a fixed body, before any DB access;
- carries `X-Correlation-Id: <investigationId>.<attempt>` (a dot: the shared correlation-ID pattern rejects `:` and would silently replace the ID);
- fails with `401 {code: "tool_unauthorized"}` if the token is missing, forged, signed by an unknown `kid`, expired, or for a different run;
- fails with `409 {code: "lease_lost"}` if the run is not `running`, the lease owner differs, or the lease has expired.

Error bodies use `packages/contracts/error-response.md`, with stable codes and no internal detail.

| Route | Request | Result |
| --- | --- | --- |
| `POST /internal/v1/investigations/:id/token` | `{leaseOwner: uuid}` | `200 {token, expiresAt}`. Token format: `v1.<kid>.<b64url(json{inv,lease,exp})>.<b64url(HMAC-SHA256)>`, verified with `timingSafeEqual`. Writes a ledger row with `tool = 'token_exchange'`. |
| `POST /internal/v1/investigations/:id/tools/:tool` | Header `X-Investigation-Token`; body `{round: 1..4, args: object}` | `200 {outcome: "ok", data, truncated}`. Model-caused failures return `200 {outcome: "invalid_args" \| "not_found" \| "limit", error: {code}}`. Errors that are not in the contract return `5xx` with a safe body. |

`:tool` must be one of the four names; anything else returns `404` and the worker maps it to `unknown_tool`. The API enforces the per-attempt call cap from the ledger: once 8 tool rows exist for `(investigation, attempt)`, it returns outcome `limit`, independently of the worker.

### Tool contracts (`packages/contracts/ai-tools/<tool>.v1.json`)

All tools are read-only. Org, project, and finding always come from the investigation row; argument schemas have `additionalProperties: false`, so supplying scope fields is an `invalid_args` error. Text fields from advisories are capped at 1 KiB each, and a whole result at 8 KiB serialized.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_finding_risk` | `{}` | Current state of the investigated finding: purl, version, ecosystem, scope, status (`open`/`resolved` + reason), match quality/reason, bounded evidence, priority (`toPriority()` output incl. tier, factors, `modelVersion`), KEV status, lead advisory (source, sourceId, aliases, summary, CVSS). Read through `findingSql()` restricted to this finding's project and (purl, group). A finding resolved since start is returned as data, not an error. |
| `list_related_findings` | `{relation: "same_package" \| "same_advisory_group", limit?: 1..10 (default 5), cursor?: string}` | Open findings in the same project, excluding the investigated finding. They are grouped leads from `findingSql()` and include: findingId, purl, version, scope, match quality, lead advisory id/aliases, priority tier, and KEV status. Also returns `nextCursor`. |
| `get_dependency_occurrences` | `{}` | Rows of `sbom_dependencies` in the finding's own `import_id` (same org and project) with the same ecosystem and package name, any version: purl, version, scope, occurrences. At most 20 rows, plus `truncated`, `importId`, and `importedAt`. |
| `lookup_advisory` | `{id: string}`, max 80 chars, pattern for CVE / GHSA / OSV-style IDs | Global intelligence: normalized advisory (source, sourceId, aliases, summary, severity, CVSS), group members (max 20), and KEV entry or `null`. It has no tenant data. Unknown IDs return outcome `not_found`. |

### Storage (migration `015_investigation_tools.sql`, additive)

- `investigation_tool_calls`:
  - Columns: `id`; `investigation_id` (FK); `org_id`; `project_id`; `attempt`; `round`; `tool` (CHECK in the four names plus `token_exchange`); `args jsonb` (validated arguments only, or NULL when invalid); `outcome` (CHECK `ok`/`invalid_args`/`not_found`/`limit`/`error`); `result jsonb` (bounded, 8 KiB, nullable); `result_bytes`; `duration_ms`; `created_at`.
  - Composite FK `(org_id, project_id, ...)` consistent with the investigation's scope.
  - Index on `(investigation_id, attempt)`.
  - No grant to `sentra_intelligence`. Append-only by convention; there is no update path in code.
- `investigations.attempt_deadline_at timestamptz NULL`, with a worker grant on this column only.
- Extend the `failure_code` CHECK with `tool_unavailable`, `tool_unauthorized`, and `deadline_exceeded`.
- New runs get `prompt_version = 2`. Existing rows keep `1`.

### Worker harness (prompt version 2)

- The system prompt is fixed and versioned. Retrieved text never enters the system role. The user message carries the snapshot as untrusted JSON, as in v1.
- Tool results are appended as `role: tool` messages with content `{"tool": name, "untrusted": true, "source": "sentra_api", "data": ...}` or `{"tool": name, "untrusted": true, "error": {"code": ...}}`.
- Classification:

| Situation | Effect |
| --- | --- |
| Unknown tool name or unparseable arguments (worker-side) | Typed error to model; counts toward the cap; no API call |
| `invalid_args` / `not_found` / `limit` from API | Typed error to model |
| Connect error, timeout, `5xx` from tool API | End attempt, retryable, `tool_unavailable` |
| `401` from tool API | End attempt, terminal, `tool_unauthorized`, no draft |
| `409 lease_lost` | Stop without writing; the existing lease and claim logic owns the run |
| Attempt deadline reached | End attempt, retryable, `deadline_exceeded` |
| Malformed `tool_calls` or tool call on the final round | Existing `invalid_output`, terminal |
| Existing provider errors | Unchanged |

- **v1 drain branch:** a claimed row with `prompt_version = 1` runs the SENTRA-17 single call. It is removed in a follow-up once no v1 runs are queued or running.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Investigations per day, peak starts | **Unknown** (unchanged from SENTRA-17) | No measured demand | Existing start counters |
| Internal tool requests per attempt | At most 8 tool calls plus at most 5 token exchanges | Derived from provisional caps | Ledger counts per attempt |
| Concurrent model jobs | 1 globally (existing default) | ADR 0007 configuration | Existing metrics |
| Tool query latency | **Unknown**. A 2 s statement timeout is set as a guard, not as a target. | Queries are restricted to one project and one purl/group. SENTRA-15 first-page p95 was 321 ms on a 25k-finding corpus for a full-project query. | Tool duration histogram on the SENTRA-15 benchmark corpus; record p50/p95 in the PR |
| Run duration | **Unknown**; bounded by the 600 s attempt deadline | Provisional | Run duration histogram and rounds per run |
| Ledger growth | At most about 13 rows and about 64 KiB of results per attempt | Derived from caps | Table size after the local test |
| Availability | Tool API outage leads to a retryable attempt failure, then the existing attempts policy; no SLO | User decision (Q9) | Fault-injection test with the API stopped |

Every cap above is a provisional configuration choice, not a product requirement. Tune it from measurements and report the values in the PR (SENTRA-26 owns targets).

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Model supplies `orgId`, `projectId`, or `findingId` in arguments | `invalid_args`; no data read | Integration test per tool |
| Model asks for another tenant's advisory/finding by guessing identifiers | Project tools take no identifiers. `lookup_advisory` returns only global data. `list_related_findings` never returns other projects' or orgs' rows. | Two-org fixture with identical purls and advisories |
| Token for run A used on run B's path | `401 tool_unauthorized` | Auth test |
| Forged signature, unknown `kid`, expired token, missing bearer, wrong bearer | `401`; no DB read for a bad bearer; no ledger row | Auth tests |
| Run completed/failed, lease expired, or lease re-claimed by another worker | `409 lease_lost`; worker stops without writing | Integration test with lease manipulation |
| Creator removed from org mid-run (Q6) | Tool calls still succeed and are limited to the project | Pinned test (accepted limitation) |
| Finding resolved mid-run | `get_finding_risk` reports `resolved` as data | Integration test |
| Project has huge related or dependency sets | Bounded page, `truncated: true`, cursor for more | Test with more than the cap rows |
| Model loops on tools or ignores budget | API refuses after 8 calls (`limit`); final round omits tools; otherwise `invalid_output` | Stub-provider harness test |
| Injection text in advisory summary or package name ("ignore instructions", "use org X", "call 50 times") | Caps, scope, and argument validation hold; text arrives only inside a `role: tool` untrusted envelope | Injection fixtures plus a stub provider that obeys the injection |
| Tool API down or slow | Attempt ends `tool_unavailable` (retryable), then the existing attempts policy | Fault-injection test |
| Bad service secret configured on worker | Terminal `tool_unauthorized`, visible in metrics; no retry storm | Integration test |
| Duplicate tool call after worker crash and retry | New attempt, new token, new ledger rows tagged with the new attempt; reads are side-effect free | Crash/retry test |
| oMLX cannot parse Qwen tool calls | Runs fail `invalid_output`; revisit Q4 with option B | Step 0 verification plus protocol tests |
| Public listener receives `/internal/...` | 404 | Test against the public app |

## Security, observability, and rollout

- **Authorization and tenant isolation:**
  - Two credentials are required on every call (Q7).
  - Run state and lease are checked on every call.
  - Scope comes from the investigation row only.
  - Argument schemas reject scope fields.
  - All tenant SQL includes `org_id` and `project_id` from the row.
  - The worker DB grant gains one column only.
  - The ledger and drafts are not exposed through any user route.
  - Secrets and signing keys come from env, are never logged or put in events, and are checked for minimum length at startup.
  - A bearer comparison failure is decided before any DB query.
- **Abuse limits:**
  - Per-attempt call cap enforced by both the API and the worker.
  - Round cap, result size caps, and statement timeout.
  - Attempt deadline and the existing global concurrency and per-org pending caps.
- **Logs and metrics:**
  - API counters: `investigation_tool_calls_total{tool,outcome}` and `investigation_tool_auth_rejections_total{reason}`; histogram `investigation_tool_duration_seconds{tool}`.
  - Worker: `investigation_tool_rounds` histogram and `investigation_worker_outcomes_total` extended with the new codes.
  - Structured logs carry correlation ID, investigation ID, org ID, tool, outcome, and duration. Arguments, results, prompts, drafts, tokens, and secrets are never logged.
  - Tenant IDs are never used as metric labels.
- **Rollout:**
  1. Run the migration.
  2. Deploy the new worker with the tool secret and URL. It handles both prompt versions and needs only `INTELLIGENCE_TOOL_TOKEN` to start: it makes no call to the listener until it claims a version 2 run, and it never holds the signing keys.
  3. Deploy the API with the listener, secret, and keys. Only now are runs stamped `prompt_version = 2`.
  4. Confirm a v2 run completes locally.

  Queued v1 runs drain on the v1 branch. This order means no worker that ignores `prompt_version` can ever see a version 2 run during a forward rollout.
- **Rollback runbook:** the previous worker does not check `prompt_version` and would run v2 runs without tools. Before starting it:
  1. Stop the worker.
  2. Redeploy the previous API, which stamps v1 again.
  3. Fail any queued or running `prompt_version = 2` runs with a documented operator SQL (`processing_error`).
  4. Start the old worker.

  The ledger and rows are retained.
- **Ownership:** API maintainers own the listener, auth, tools, and ledger. Worker maintainers own the loop and classification.

## Acceptance criteria

Mapped to the story's criteria (S1 to S8) and to the tests that prove them.

- [ ] (S1) The model has no DB access or SQL capability. Its only data path is the four typed tools on the internal listener, and the worker DB role gains only `attempt_deadline_at`. Proven by a role grant test (worker role denied `findings`, `sbom_dependencies`, `vulnerabilities`, `investigation_tool_calls`) and a contract test listing registered internal routes.
- [ ] (S2) Each tool has a versioned JSON Schema for arguments and results in `packages/contracts/ai-tools/`. The API validates arguments and serializes results against them. Proven by schema contract tests per tool.
- [ ] (S3) Every tenant tool is scoped to the investigation's org and project, taken from the row. Proven by two-org/two-project fixtures with identical packages and advisories in `investigation-tools.integration.test.ts`.
- [ ] (S4) Authorization does not depend on model output. Proven by:
  - tests for the bearer secret, signed token, run state, and lease (forged, expired, wrong run, wrong `kid`, stale lease, finished run);
  - tests that scope arguments are rejected;
  - the API-side call cap;
  - the Q6 pinned test.
- [ ] (S5) Every authenticated tool call and token exchange writes one ledger row with tool, outcome, attempt, round, duration, and bounded result. Metrics and logs exist without sensitive content. Proven by integration tests asserting ledger rows and a log-redaction test.
- [ ] (S6) Retrieved content arrives only in `role: tool` untrusted envelopes, and the system prompt is fixed at `prompt_version = 2`. Proven by injection fixtures with a stub provider that follows the injected instructions, showing caps, scope, and arguments hold.
- [ ] (S7) Tool failures are classified per Q9 and never expose raw API or provider text. Proven by worker unit and integration tests for each row of the classification table.
- [ ] (S8) Cross-tenant tests exist. The SENTRA-21 coverage check is extended so every internal route needs a case or exemption, and the public app is shown not to serve `/internal/*`.
- [ ] New runs use tools; runs queued before deploy finish on the v1 branch; the rollback runbook is documented and tested once locally.
- [ ] Step 0 facts are recorded as **Verified** or replaced, with the decision path taken if they fail.
- [ ] ADR 0009 and the learning note are written. The SENTRA-17 spec and ADR 0007 reference ADR 0009 for the tool amendment.

## Verification

- **Manual:**
  1. Start the stack with oMLX and the worker profile.
  2. Start an investigation from the browser on a finding whose package has related findings and a KEV-listed advisory.
  3. Confirm it completes.
  4. Inspect `investigation_tool_calls` via psql: expected rows, outcomes, and no cross-project data.
  5. Stop the API mid-run: the attempt is retried, then ends `tool_unavailable`.
  6. Set a wrong worker secret: the run ends `tool_unauthorized`.
  7. Curl the public port at `/internal/v1/...`: 404.

  Record timings and the final default values.
- **Automated:**
  - API integration tests against real Postgres for the listener, auth, tools, ledger, and isolation.
  - Worker unit tests with a deterministic local HTTP stub, for both oMLX and the tool API, covering the loop, bounds, classification, lease renewal, and token refresh.
  - One end-to-end local run against real oMLX.
  - Replace model substitution with real services wherever determinism is not needed.
- **Load and failure:** a burst of tool calls against the SENTRA-15 benchmark corpus to measure tool latency, plus fault injection for the tool API down, a lease lost mid-loop, and a worker crash between tool calls.

## Implementation plan (stacked PRs)

The story is L-sized. Split it into two stacked PRs: PR 1 (API: steps 1 to 5) is branched from `feature/SENTRA-18-tenant-safe-ai-tools`, and PR 2 (worker and rollout: steps 6 to 9) is branched from PR 1.

0. **Verify the unverified facts (blocking gate, no code).**
   - oMLX tool calling with the served model: `tool_calls` parsing, `role: tool` follow-ups, and a final round without `tools`.
   - Docker-to-host reachability for the chosen listener bind.

   Record the results in this spec. If tool parsing fails, stop and return to Q4.

   **Status (2026-10-09): the oMLX facts are Verified (see Context). The Docker-to-host bind check is covered by the implementer's run; see Implementation notes.** PR 1 did not depend on it.
1. **ADR 0009 and contracts.** Write ADR 0009 (internal tool listener, layered auth, API-owned ledger, run-scoped authority) and the four tool JSON Schemas. Tests: schema files validate.
2. **Migration 015.** Ledger table, `attempt_deadline_at` plus its grant, failure codes. Tests: migration applies; worker role grant and denial assertions.
3. **Internal listener and auth.** Config (required, length checks), separate Fastify instance, bearer check, signing keyring with `kid`, token exchange, and the run/lease check helper. Tests: every auth unhappy path; the public app does not serve `/internal`; startup fails without config.
4. **Tools and ledger.** The four handlers reuse `findingSql()`/`toPriority()`, plus bounded truncation, the API-side call cap, ledger writes, metrics, and logs. Tests: per-tool happy path, two-org/two-project isolation, scope arguments rejected, truncation and cursor, resolved finding, Q6 pinned test, ledger rows.
5. **SENTRA-21 extension.** The coverage check includes internal routes. Add cases or exemptions. Run `task api:test:isolation`.
6. **Worker harness v2.** Tool-API client, token exchange and refresh, bounded loop with lease renewal and deadline, untrusted envelope, prompt v2, classification, v1 drain branch, config invariant check. Tests: stub-based unit tests for each classification row, caps, final round, injection fixtures, and the lease-lost stop.
7. **API stamps `prompt_version = 2`, plus Compose and env wiring.** Worker env, API env template, documentation in the `services/intelligence` README. Tests: existing investigation integration tests updated.
8. **End-to-end and failure verification.** Manual steps above, a real oMLX run, fault injection, benchmark latency, and one local rehearsal of the rollback runbook.
9. **Docs.** Learning note `docs/learning/SENTRA-18-tenant-safe-ai-tools.md`; cross-links from the SENTRA-17 spec and ADR 0007.

## Definition of done

- `task check` (format, lint, typecheck, unit tests across API and intelligence) and `task test:integration` including `task api:test:isolation` pass.
- `task fallow` reports no findings, or each unfixable one is documented.
- Step 0 facts are labeled **Verified**, with how they were checked.
- The manual and failure checks above are recorded with actual timings and defaults.
- ADR 0009, the learning note, and the spec are current. The YouTrack story links this spec and its acceptance criteria are updated.
- PRs use `.github/pull_request_template.md` and link the story URL, spec, ADR, and learning note.

## Open questions and assumptions to validate

- oMLX/Qwen tool-calling behavior and the Docker-to-host bind (step 0, implementer, before PR 1 code).
- Every numeric cap is provisional; tune from measurements and report in the PR: 4 rounds, 8 calls, 5 s tool timeout, 600 s deadline, 8 KiB per result, 1 KiB per text field, 10 per page, 20 occurrences, 2 s statement timeout.
- Retention of ledger results and drafts: **undefined**, shared with SENTRA-17. It needs a product decision before production data.
- D1 (API-only argument validation), D2 (truncation is `ok` plus `truncated`), and D3 (final round without tools) are planner proposals for user confirmation.
- Whether SENTRA-19 cites ledger row IDs directly as evidence references is decided in SENTRA-19.

## Implementation notes (recorded at hand-off)

- **Step 0, oMLX facts Verified (2026-10-09):** the served `Qwen 3.8:27b` returns parsed `message.tool_calls`, accepts `role: tool` follow-ups, and answers in plain content when `tools` is omitted. Q4 option A stands; no fallback to option B needed. Probes were run by the user; details under Context.
- **Verified (running system, 2026-10-09):** a Docker Desktop container reached an API listener bound to host loopback (`127.0.0.1:4001`) through `host.docker.internal` and received the expected `401` for a missing bearer. The default bind stays loopback; no wider bind is needed. The public port answered `404` for `/internal/v1/...`.
- **Verified (running system, 2026-10-09, with a scripted stand-in for the model, not oMLX):** the built worker image (tool contracts mounted through a compose build context), the real API process and a scratch Postgres database completed a run: token exchange, three tools plus one scope-argument attempt (`invalid_args`), a second token exchange, and a draft. The ledger held the expected rows. A wrong service secret ended a run `tool_unauthorized` (terminal, one attempt). With the API stopped, the run was retried twice and then failed `tool_unavailable` after three attempts. This does not exercise the model's real tool-call format.
- **Verified:** the rollback SQL (`services/intelligence/runbooks/rollback-prompt-v2.sql`) fails queued and running `prompt_version = 2` runs and leaves version 1 and finished runs alone (`task intelligence:test:integration`).
- **Not measured:** tool latency on the SENTRA-15 benchmark corpus, and real oMLX timings. The default caps are unchanged.
- **Deviation:** the correlation header is `<investigationId>.<attempt>`, with a dot, because the shared correlation-ID pattern rejects `:` and would replace the ID. The envelope the model sees gains `truncated` on success. An unexpected `4xx` from the tool API (a worker bug) ends the attempt terminally as `processing_error`.
- **Not done by design:** rejected requests (bad credentials, lost lease) write no ledger row; they are counted in `investigation_tool_auth_rejections_total{reason}`.
- **Rollout order (user decision, after review):** migrate, then new worker, then new API. Checked against the code: the worker starts with only the database URL and `INTELLIGENCE_TOOL_TOKEN` (no listener call and no signing keys at startup), and a claimed `prompt_version = 1` run uses the single model call without touching the tool client. This replaces the earlier "migrate, API, worker" order.
