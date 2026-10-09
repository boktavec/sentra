# SENTRA-17: Start finding investigation

- Status: Implemented on feature branch; pending PR review
- YouTrack: http://localhost:8080/issue/SENTRA-17
- Architecture decision: [ADR 0007](../../adr/0007-durable-investigation-runs.md)
- Owner: Project member; operational owners: API and intelligence worker maintainers

## Problem and outcome

A project member can see a finding but cannot ask Sentra to investigate it. This story gives the member a browser path to select an open finding, start a durable AI-assisted investigation, and see every run's status. The request remains visible through broker or model outages. A successful worker call saves a private draft for the later evidence-based summary story.

Done means an authorized member can select a finding on a dedicated investigation page, start a run, see it move through queued/running/completed or failed, and review all runs for that finding. Duplicate starts while a run is active return the same run. A completed run has a persisted, tenant-scoped draft; the UI does not present that draft as an investigation answer in this story.

## Scope

- In scope:
  - A link from the existing project page to a dedicated investigation page with a paginated finding picker, a start action, and paginated run history/status for the selected finding.
  - Tenant-scoped start, history, and status API routes; investigation, finding snapshot, and outbox persistence; creation audit event.
  - A transactional outbox relay to Redpanda and a Dockerized Python intelligence worker that calls the existing host-native oMLX server through a narrow provider client.
  - Bounded retries, leases/crash recovery, idempotent event handling, per-organization pending cap, global worker concurrency cap, safe error codes, and metrics/logs.
  - SENTRA-21 tenant-isolation cases for every new route, replacing the `investigations` todo.
- Out of scope:
  - A user-facing generated summary, evidence citations, and guidance (SENTRA-19).
  - Model-initiated tools, retrieval, or arbitrary queries (SENTRA-18).
  - A general agent framework, LangChain, additional model providers, or autonomous remediation.
  - A findings detail page (SENTRA-16). The picker uses the existing SENTRA-15 findings list API.
  - A product-wide retention policy. Drafts remain with investigation records until such a policy is defined.
- Dependencies and related stories: SENTRA-13 supplies findings; SENTRA-15 supplies the grouped, paginated findings list; SENTRA-21 supplies the isolation suite. SENTRA-16 may add a finding detail path; SENTRA-18/19 build on this lifecycle.

## Decisions and alternatives

Third-party claims are labeled **Verified** or **Assumed** below. Repository contracts were inspected on 2026-10-08; runtime behavior remains to be checked during implementation.

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| User entry | Project page link to a dedicated investigation page with a finding picker | Inline project-page section; direct ID-only URL | Keeps the project page small and uses SENTRA-15's existing findings list contract. Costs a small selection UI alongside the findings list. |
| Output in this story | Save a private draft after a real model call; show status and all run history, but not draft text | Mock processing; show a temporary answer; implement all of SENTRA-19 | Proves the async and failure path without presenting an unevaluated model answer as evidence. The draft format may change in SENTRA-19. |
| Dispatch | Investigation and event outbox row commit in one Postgres transaction; relay publishes a reference event to Redpanda | Postgres-only queue; publish plus sweep | No committed request is lost between DB write and publish. Costs a relay and outbox table. This follows the existing SBOM outbox pattern and ADR 0002 envelope. |
| Runtime | Python worker in Docker; oMLX stays native on the Mac; configurable OpenAI-compatible URL, model ID, and API key | Containerized model; Ollama; llama.cpp; LangChain | Reuses the user's running MLX model and keeps the worker deployable. Local networking and credentials need explicit setup. |
| Model input | Versioned, bounded snapshot of the authorized finding, its match evidence, lead advisory and all linked advisory facts from its SENTRA-12 group, captured at start | Reload at execution; include SBOM/project context; model tools | Reproducible input and a narrow tenant-data boundary. A later finding or advisory group change does not alter the run. |
| Eligibility | Any open finding, whether `confirmed` or `unverifiable`; reject resolved findings | Confirmed only; historical resolved findings | Uncertainty is itself useful to investigate; resolved findings are no longer current exposure. |
| Duplicate starts | At most one queued/running run per finding; concurrent starts return it; a new run is allowed after completion or failure | One run forever; every click creates a run | Prevents duplicate model work while allowing a fresh attempt. Enforce with a partial unique index, not an application-only check. |
| Visibility | Any current member of the finding's organization may read status/history; creator is recorded | Creator-only; creator plus admins | Investigations are shared project work. Every read remains scoped to organization, project, and finding. |
| Failure | Retry only transient provider/network errors with bounded backoff; terminal safe failure code after exhaustion | First-error failure; unbounded retries | Preserves requests during brief outages without leaving them active forever. Values are configuration, then measured and tuned. |
| Retention | Persist private draft with the investigation until a policy is introduced | Fixed 30-day expiry | Avoids silent deletion before SENTRA-19 can use it. Sensitive draft access and future retention need explicit review. |
| Capacity | Per-organization cap on queued/running investigations plus a global worker concurrency cap | Global cap only; daily per-user quota | Prevents one tenant filling the model queue without building a general quota system. Numeric defaults are provisional and must be measured. |

### Third-party facts and verification status

- **Verified (oMLX source documentation via Context7, `/jundot/omlx`, 2026-10-08):** oMLX exposes `POST /v1/chat/completions` and `GET /v1/models` and accepts an OpenAI-compatible client. The documented CLI default is port 8000. Source: https://github.com/jundot/omlx/blob/main/README.md.
- **Verified (running system, 2026-10-08):** `http://localhost:8000/v1/models` responded with HTTP 401 without authentication and HTTP 200 with the locally configured key. No credential was copied into the repository.
- **Verified (running system, 2026-10-08):** the intended underlying model is `lmstudio-community/Qwen3.8-27B-MLX-4bit`, but authenticated `/v1/models` advertises it as `Qwen 3.8:27b`. A real `/v1/chat/completions` call with that served ID returned HTTP 200 and nonempty content. The API stores the served ID in each run; it remains configurable through `INVESTIGATION_MODEL_ID`.
- **Verified (oMLX source documentation):** a non-loopback bind requires an API key. Source: https://github.com/jundot/omlx/blob/main/README.md. **Verified (running system):** Docker Desktop reached the host oMLX at `host.docker.internal:8000`; an unauthenticated container request got HTTP 401. Docker documents that host name: https://docs.docker.com/desktop/troubleshoot-and-support/faqs/general/.
- **Verified (running system):** a Dockerized worker called the authenticated host oMLX with a scoped test finding and completed in one attempt, persisting a private draft. A Playwright browser run independently created an authorized finding investigation and observed completion. Model protocol tests cover empty/malformed output, timeout, HTTP rejection, and unavailability. HTTP success does not establish factual accuracy.

## Architecture and contracts

### Ownership and flow

```text
Project member -> Web investigation page -> TypeScript API
  -> authorize organization/project/finding and open status
  -> one transaction: investigation + immutable context snapshot + outbox event + audit event
  -> outbox relay -> Redpanda `investigation.requested.v1`
  -> Python intelligence worker (Docker)
  -> claim investigation in Postgres, read stored snapshot, call oMLX on Mac
  -> persist bounded private draft or safe failure state
  -> Web polls API for status/history
```

The API/domain layer chooses the tenant and serializes the snapshot. The model receives no database connection, tenant selector, tools, secrets, or arbitrary SQL capability. The worker's DB role may read/update investigation lifecycle rows and snapshots, but not unrelated tenant data; a live connection test confirmed it can read `investigations` and is denied `findings`. oMLX's built-in tools and MCP integration are not enabled for this call.

### Proposed HTTP contract

All routes require authentication and current organization membership; project and finding IDs must resolve within that organization. Cross-tenant and nonexistent resources return the same 404 shape. The API never returns the private draft in this story.

| Route | Result |
| --- | --- |
| `POST /v1/orgs/:orgId/projects/:slug/findings/:findingId/investigations` | `201` with `{id, status, findingId, createdAt}` for a new queued run; `200` with the active run for a duplicate start. No client-supplied tenant, project, or user fields. Resolved or unknown finding: 404 or a documented domain error, with no mutation. Pending-cap rejection: 429 with a stable error code. |
| `GET /v1/orgs/:orgId/projects/:slug/findings/:findingId/investigations?limit&cursor` | Bounded, newest-first history of all runs for the finding, with `nextCursor`. Metadata/status only. |
| `GET /v1/orgs/:orgId/projects/:slug/findings/:findingId/investigations/:investigationId` | Current status, timestamps, attempt count, and safe failure code when failed. No prompt, draft, raw provider response, or credentials. |

The existing paginated findings route supplies the picker with `status=all`, `severity=all`, and `sort=newest`. The page labels resolved rows as unavailable for Start and preserves pagination. The SENTRA-15 findings list and this picker remain separate entry points to the same grouped findings. Error responses follow `packages/contracts/error-response.md`.

### Proposed storage and event contract

- `investigations`: ID; `org_id`, `project_id`, `finding_id`, `created_by`; `status` (`queued`, `running`, `completed`, `failed`); immutable versioned context snapshot; model ID and prompt version; private bounded draft; safe failure code; attempt count, next attempt time, lease owner/expiry; created/started/completed/updated timestamps. Foreign keys and composite scope checks prevent mismatched organization/project/finding associations. An index serves finding history; a partial unique index enforces one active run per finding.
- `investigation_outbox`: event ID, investigation ID, versioned payload, creation and due/sent timestamps, attempt count. Written in the same transaction as the investigation and audit row. Relay retries broker failures and reports depth/oldest age.
- `investigation.requested.v1`: ADR 0002 envelope (`eventId`, type/version, timestamp, correlationId) plus stable investigation ID and tenant/project references. The worker treats event fields as routing hints and loads authoritative scope from the DB row. It ignores duplicate delivery for terminal runs. Contract JSON Schema lives in `packages/contracts/events/`.
- `audit_events`: extend `target_type` for `investigation` and record `investigation.created` only when a new run is created, in the same transaction, with actor, tenant, target, and correlation ID. No prompt or draft in metadata.
- Database migration is additive. Rollout order: migrate, deploy API/relay/worker, then expose the UI. If the broker or oMLX is down, the API and rest of Sentra still start; accepted rows remain queryable. Rollback disables creation/worker while retaining rows and audit history for recovery.

### State and recovery rules

- Valid transitions: `queued -> running -> completed`, or `queued/running -> failed`; transient attempt failure returns to `queued` with next attempt time. Terminal states never revert. A new user start after a terminal state creates a new ID.
- A worker claims with a bounded lease. If it crashes, lease expiry makes the same run eligible for retry. Duplicate broker events and concurrent workers must not create multiple terminal writes. A crash after oMLX responds but before commit may call the model again; the persisted run and audit event still remain one. No user-visible side effect is delegated to the model.
- A relay crash after publish but before marking sent may publish the same event again; the worker claim/status check handles it. Outbox rows are not deleted before successful publish.
- If an event is irrecoverably missed after publish, a periodic reconciliation of queued/expired-lease rows republishes or processes them. The design and interval should reuse existing outbox/sweep conventions; a fault-injection test must prove a committed request cannot remain silently stranded.
- Provider timeout, unavailable endpoint, 429/5xx, and malformed or empty output are classified. Only transient errors are retried; retries and calls have explicit timeout and max output size. The user-facing status exposes a safe code, never raw provider text. Draft text is treated as untrusted data even after persistence.

## Workload and targets

The user has no measured launch demand or latency/availability target. These values are **Unknown**, not invented requirements. Initial configuration will be conservative and bounded; record actual defaults and measurements in the implementation PR and revisit them with SENTRA-26.

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Starts/day and peak requests | **Unknown** | User decision | Count starts and rejected starts with bounded outcome labels; run a local burst test. |
| Concurrent model jobs | **Unknown**; globally capped by config | User decision | Measure oMLX duration, memory and worker saturation, then tune. |
| Queue size per organization | **Unknown**; capped by config | User decision | Measure pending depth and rejections; test one org cannot block another. |
| Input/output size | 64 KiB snapshot, 16 KiB draft, 768 requested output tokens: provisional configured limits | Implementation choice, not a product requirement | Real scoped browser and worker call completed within these limits. |
| Start API and queue wait latency | **Unknown** | No SLO supplied | Record API duration, queue age, run duration, model latency; report p50/p95 and failure rates from local test. |
| Availability/recovery target | **Unknown**; durable request and eventual terminal state required | User decision | Outbox retry, due-row sweep, expired lease at max attempts, and a temporary worker calling an unreachable model port were verified locally. |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Double click or concurrent starts | One active row and one audit event; both requests receive its ID | Concurrent API integration test and DB assertions |
| Resolved, nonexistent, or other-tenant finding | No investigation or outbox row; tenant denial indistinguishable from nonexistent | API and SENTRA-21 isolation suite |
| Finding changes after start | Worker uses immutable captured evidence; history remains tied to original finding | Update/resolve finding while queued; inspect snapshot/model request |
| Broker unavailable or relay crash after publish | Request stays queued; relay retries; duplicate event cannot duplicate work | Fault-injection integration test |
| Worker crash during call or before commit | Lease expires and run retries; one terminal row; possible repeated model call is recorded | Crash/restart test with controlled provider |
| oMLX unavailable, slow, rate limited, or malformed | Bounded retry for transient cases, then safe failed state; no raw error in API/logs | Local stub plus real stopped oMLX check |
| User loses membership after start | Worker may finish the already-authorized snapshot; former member cannot read status/history | Remove membership while queued; API isolation check |
| One tenant floods starts | Per-org pending cap rejects further starts without affecting other orgs | Integration test with two organizations |
| Untrusted advisory text in snapshot | Sent as quoted data with fixed system instruction; no model tool access; output never treated as authoritative | Prompt-injection fixture and provider-request inspection |

## Security, observability, and rollout

- Authorization: API resolves current membership and project before finding lookup; all SQL reads/writes include tenant/project scope. The worker loads scope from the authoritative investigation row, not from the event or model. Current members can read run history; the creator is retained for audit. Add start, history, and status cases to the isolation suite, including dual-member ID swaps and mutation checks.
- Sensitive data: context snapshot and private draft stay in Postgres, are excluded from API/status/history responses and routine logs, and are accessible only to scoped application paths and the least-privilege worker role. API key comes from local secret configuration, never from the repository or an event. The local oMLX bind must require authentication if exposed beyond loopback; verify from inside Docker. No hosted model fallback.
- Abuse controls: per-org pending cap, global concurrency cap, bounded input/output, provider timeout, bounded retries and backoff. No unbounded poll/list operations. User-facing failures are stable, safe codes.
- Telemetry: audit `investigation.created`; structured logs with correlation ID, investigation ID, tenant ID, status transition and safe error category (no prompt/draft/key); counters for starts, dedupe, cap rejection, completions, failures, retries and provider errors; histograms/gauges for API duration, queue age, model latency, run duration, outbox depth/age and active jobs. Avoid tenant IDs as high-cardinality metric labels.
- Rollout and ownership: API owns creation/authorization/status and outbox relay; intelligence worker owns model call and terminal state. Run migrations before code. Start with local oMLX and test the authenticated Docker-to-host connection. There is no automatic deletion of drafts in this story.

## Acceptance criteria

- [ ] A current organization member can reach the investigation page from a project, browse paginated findings, select an open confirmed or unverifiable finding, and start a run.
- [ ] Creation atomically persists the correct tenant, project, finding, creator, immutable context snapshot, outbox event, and one audit event; no model call blocks the HTTP request.
- [ ] Concurrent or repeated starts while queued/running return one active run; after completion/failure a new run is possible; resolved findings cannot start a run.
- [ ] The page and API show paginated history of **all** runs for a finding and current queued/running/completed/failed status. No private draft or raw provider error is exposed.
- [ ] The Dockerized Python worker calls the configured authenticated oMLX endpoint using its served ID `Qwen 3.8:27b` locally, persists a bounded private draft on success, and reaches a safe failed state after bounded transient retries.
- [ ] Broker, worker, and model failures do not lose committed requests; duplicate events and worker restarts cannot create duplicate terminal records or cross-tenant reads.
- [ ] The API and rest of Sentra start when oMLX is stopped; affected investigations remain retrievable and eventually fail safely after retries.
- [ ] Per-organization pending and global processing limits are enforced and observable; relevant counters, durations, queue age, and audit/structured log records exist without sensitive content.
- [ ] Every start/history/status route has cross-tenant and relevant mutation cases in `apps/api/src/tenant-isolation.integration.test.ts`; its `investigations` todo is removed.
- [ ] UI is manually checked in the browser, with Playwright screenshots committed under this feature folder and referenced in the PR by commit-SHA permalinks.

## Verification

Implementation evidence (2026-10-08 local stack): `task check` passed across web, API, platform, crawler, pipeline, and intelligence; `task fallow` found no issues. Five investigation API integration tests and the SENTRA-21 isolation suite passed against Postgres. Playwright completed the browser flow in 52.1 seconds and saved three screenshots. The Docker worker called authenticated oMLX for the browser-created run and saved a private draft. The API relay published all pending local outbox rows to Redpanda. A live worker-role query read `investigations` and was denied `findings`. A seeded expired lease at three attempts became `failed/attempts_exhausted`. A separate worker with an unreachable model URL reached `failed/provider_unavailable` after exactly three attempts, with no draft. These are local proofs, not availability or latency SLOs.

- Manual: from a project, open the investigation page, page through findings, start an open finding, reload, observe its state and every historical run; stop oMLX and confirm a new request is saved and eventually fails safely; restart oMLX and start again. Expected status and audit/telemetry behavior should be recorded with actual timings.
- Automated: real Postgres/API integration tests for authorization, atomic creation/audit/outbox, duplicate concurrent starts, eligibility, history paging and cap; real broker/outbox/worker tests for redelivery/crash recovery; provider protocol tests with a local deterministic HTTP server for timeout, malformed output, retry and safe failure; SENTRA-21 isolation cases. Test through real entry points and only substitute the model server where deterministic failure injection is needed.
- Gates before implementation completion: relevant Task formatting, lint, type checking, unit/integration tests, `task fallow`, browser verification, and manual failure checks. Run only after implementation exists.

## Open questions and assumptions to validate

- Exact oMLX app/server version, authenticated `/v1/models` alias, successful completion response, and Docker reachability are **Assumed** until checked against the running system. Do not copy the API key into the spec or test output.
- Numeric worker concurrency, per-org pending cap, retries, timeouts, snapshot/output bounds, and outbox recovery interval are **Assumed** configuration choices. Pick conservative initial values after measuring the local model and report them in the PR; they are not product SLOs.
- Product latency, throughput, and availability targets are **Unknown**. Capture baseline measurements and propose targets under SENTRA-26 rather than presenting guesses as requirements.
- The exact private draft schema is provisional. SENTRA-19 should define the evidence-based, user-facing result separately and decide whether to reuse or replace drafts.
- SENTRA-16 can link its future finding detail page directly to this investigation page.
