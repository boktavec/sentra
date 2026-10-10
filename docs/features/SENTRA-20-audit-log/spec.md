# SENTRA-20: Review organization audit history

- Status: Implemented locally — API integration and browser regression suite passed; awaiting PR/production retention decisions
- YouTrack: http://localhost:8080/issue/SENTRA-20
- Owner: Sentra operator (admin)

## Problem and outcome

Organization administrators need to trace security-sensitive activity without database access. Existing PostgreSQL `audit_events` rows cover successful organization creation, project creation, completed SBOM upload, membership/invitation changes, and investigation creation, but there is no read API or page. Failed attempts have no organization audit rows. Done means an admin can browse and filter safe, tenant-scoped success/failure history; operators can investigate sanitized API failures in structured logs.

## Scope

- In scope: admin-only audit list API and web page; date/actor/action/outcome filters with bounded newest-first pagination; result and safe failure category in records; best-effort failed-attempt rows for verified members' sensitive workflows; one sanitized operator log event for every unsuccessful API request (4xx/5xx); SENTRA-21 isolation suite cases; docs and tests.
- Failed tenant workflows: project creation, SBOM upload initiation and completion, membership role change/removal/leave, invitation creation/revocation, investigation creation. Organization creation failures have no established tenant. Failed invitation acceptance, unknown-tenant/non-member requests, unauthenticated requests, malformed requests rejected before tenant resolution, and all other API failures are operator-log-only. Successful invitation acceptance and organization creation remain in org history.
- Out of scope: an operator events database/API/UI, auditing read failures in tenant history, generic auditing of background jobs, retroactively producing missing historical failure rows, new authentication/roles, certification claims, export, free-text search, and unbounded list endpoints.
- Dependencies: SENTRA-2 (done, table and transactional audit model); SENTRA-3/4/5/17/28 (existing writers); SENTRA-21 (replace audit todo).

## Decisions and alternatives

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Delivery | Read API plus admin-only web page | API only | The administrator can actually review activity in product; needs browser checks. |
| Success persistence | Reuse append-only PostgreSQL rows, keep successful write and audit insert in one transaction | Queue or log-only | Existing guarantee avoids successful changes without an audit row; DB write availability is required. **Verified** in repo: `002_organizations.sql`, `orgs.ts`, `org-tx.ts`, and other audited stores. |
| Failure visibility | Verified-member failures for named sensitive workflows in tenant history; all 4xx/5xx in operator logs | All denials in guessed org; only success | No attacker-controlled writes to victim tenant history or guessed tenant attribution. Operator logs are not a durable compliance archive. |
| Failure write outage | Best-effort independent insertion after rejection/rollback; preserve original response, log/measure audit write failure | Mask the rejection; write failure in failed transaction | Never change 403 into 500 or recursively audit a failed audit write. Missing failure rows during outage are an explicit limitation. |
| History view | Newest-first keyset pagination; date, actor UUID, exact action, success/failure filters | Unbounded list; search backend | Bounded database and browser work with existing pagination style. Filter state persists between pages. |
| Information exposure | Explicit allowlist for API fields and operator logs, safe error code/category only; no `metadata`, request data, exception text, raw URL or auth headers | Return entire audit row | Existing rows contain filename metadata; do not expose it. Stop adding unnecessary filenames to new SBOM audit rows; historical stored metadata cannot be retroactively deleted under the append-only trigger. |
| Client IP | Include request-derived IP only in restricted operator failure logs | No IP; raw forwarding header | Useful for anonymous-abuse investigation; access and retention require operational controls. **Assumed** until verified against actual proxy config and a spoofed-forwarded-header test. |

## Architecture and contracts

- Ownership: `apps/api` owns audit writes, list query and authorization; `apps/web` renders the history. PostgreSQL remains source of truth. No additional dependency or service.
- Success flow: existing domain transaction commits change plus audit row, with `result = success` for existing rows via schema default. Idempotent retries/no-op responses do not invent new successful change events.
- Failed flow: a response-level hook emits exactly one sanitized structured `api_request_failed` operator event for each 4xx/5xx (including directly returned non-2xx responses, failures before authentication, and unmatched routes); the error boundary supplies a safe error category when available. It records status, stable route pattern when matched (fallback fixed `unmatched`), correlation ID, request IP from trusted-proxy handling, and verified user/org IDs only when available; no headers/body/query/raw URL/exception message. For mapped sensitive mutation routes, only when `request.tenant` was established by membership resolution, make one best-effort insert into `audit_events` outside the rolled-back domain transaction. Use a fixed route-to-domain-action mapping (e.g. `project.create` failure vs existing `project.created` success); safe error category from allowlisted `AppError` code or `internal_error` for unexpected failures. Never copy arbitrary reason strings or rejected identifiers. Failed invitation acceptance cannot use the invitation token to choose an org. A request failing before membership resolution never gets a tenant audit row.
- Storage: additive migration for `audit_events.result` (`success` default, `success|failed` check), nullable `failure_code`, and nullable `target_id` for failures without a verified target; successful rows retain real target UUIDs. Keep `actor_user_id` and `org_id` required. Use `target_type` as a fixed mapped type and `target_id` only for trusted/validated resource IDs (otherwise null). Keep append-only trigger; check that normal HTTP APIs expose no update/delete path. Add or adjust `(org_id, created_at DESC, id DESC)` index for stable keyset scan; assess filtered queries via EXPLAIN with production-shaped fixture before adding filter indexes.
- Read: `GET /v1/orgs/:orgId/audit-events?from=<UTC ISO 8601>&to=<UTC ISO 8601>&actorId=<UUID>&action=<exact>&result=success|failed&limit=<1..100>&cursor=<opaque>` returns `{items, nextCursor}`. `items` expose `id, orgId, actorUserId, action, targetType, targetId|null, createdAt, result, failureCode|null, correlationId`; never expose `metadata`. Defaults to 50, newest first by `(created_at, id)`. `from` inclusive, `to` exclusive; require `from < to` when both provided. Validate and bound lengths of all query inputs and cursor; reject malformed or filter-mismatched cursors with 400. Require authentication, `scopeTo` membership, then `requireAdmin`; outsider/unknown org returns indistinguishable 404, member 403. SQL must use server-resolved `tenant.orgId`, not arbitrary client scope. Browser filter form uses accessible native controls and preserves query on pagination, with explicit empty and API-unavailable states; link visible only to admins, but API checks remain authoritative.
- Compatibility: additive schema change, existing writers remain valid and historical rows read as successful. Existing action names are not rewritten. No new third-party API/default is trusted without runtime verification; **Assumed** request IP behavior until tested behind configured proxy mode.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic, peak, failure bursts | Unknown | User has no measurements | Measure requests, statuses and audit insert rate before production; exercise a burst of rejected requests |
| Concurrent admins/jobs | Unknown | No capacity target asserted | Exercise parallel reads/writes; bound page limit and DB pool |
| Audit rows and growth | Unknown | Writes accumulate, no retention decided | Track rows/bytes per org and daily failure counts; choose retention before production rollout |
| List latency/throughput | Unknown | No new numeric SLO asserted | Observe request duration and EXPLAIN on realistic volumes before setting target |
| Availability/recovery | Unknown | Success writes fail closed; failure writes fail open | Fault-inject audit insertion; record missing-row limitation and operational alert |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Empty history, bad dates/IDs/result/cursor, filter changes between pages | Empty items and null cursor, or 400 for invalid inputs; cursor cannot silently carry previous filter | API/UI tests |
| Identical timestamps, new writes during paging | `(created_at, id)` keyset yields deterministic pages without duplicates; later writes show after refresh | SQL integration test |
| Audit table unavailable on successful mutation | Transaction rolls back underlying change | Existing regression tests and fault injection |
| Audit insertion fails after rejected mutation | Original status/body retained; safe log/metric indicates missing audit row, no recursive failure | Fault injection |
| Retried success/no-op; retried failed request | No extra success event for no-op; each separate failed request may get its own attempt row and log | Integration test |
| Unauthenticated, unknown org, removed member, or wrong-tenant request | Operator log only, never write guessed tenant; read route: 401 or indistinguishable 404, member 403 | Isolation suite and access tests |
| Malicious payload, forged `X-Forwarded-For`, invalid/missing target ID | No payload, token, raw URL, unvalidated target, or forged IP in returned rows/logs | Redaction and proxy tests |

## Security, observability, and rollout

- Tenant scoping on server-resolved membership, admin-only reads and UI, no mutating audit HTTP endpoint. Verify stale-role behavior on read per existing route semantics. No raw metadata in responses; remove unnecessary filename from future SBOM audit inserts. Audit rows are append-only against ordinary SQL; table owner/superuser can drop trigger (existing limitation), so not WORM storage.
- Emit sanitized `api_request_failed` per 4xx/5xx with bounded fixed fields, no unexpected `err` object in that event. Count failed tenant-audit inserts separately; make failures visible to operators. Follow deployed log access and retention controls; never claim logs are lossless. Correlation ID links events to request logs. Track API latency, event growth and DB errors via existing observability patterns.
- Roll out additive migration before code and test mixed old/new writers. Set operational log/database retention and owners before production rollout; no guessed duration. Rollback can disable new reads/failure writes while retaining additive columns and rows; do not delete audit data. Owner: API operations/security for event access and retention.

## Acceptance criteria

- [ ] Existing named successful activities have one committed audit row per actual change with actor, org, action, target, timestamp, correlation ID where available, and success outcome.
- [ ] Verified members' failed sensitive workflow attempts create tenant rows with `failed` and a safe error category even if the domain transaction rolls back; unavailable audit storage preserves the original rejection and records the gap operationally.
- [ ] Every API 4xx/5xx emits one sanitized operator event; anonymous, non-member, failed org creation and failed invitation acceptance are operator-log-only, with no tenant guess or payload leakage.
- [ ] Organization admin can browse/filter/page through only their own safe audit history; ordinary members get 403, outsiders 404, unauthenticated 401; no normal API mutates audit events.
- [ ] SENTRA-21 audit isolation todo is replaced with cases for this route, including real admin success, member denial, outsider equivalence and tenant-scoped filtering; tests cover redaction and same-timestamp paging.
- [ ] Admin-only browser link and page work with empty, filtered, subsequent-page, and unavailable states; manual browser verification and screenshots are saved under this feature folder.

## Verification and implementation steps

1. Add additive migration and adjust existing audit insertion to avoid unnecessary filename metadata; validate old events still render as success and trigger still blocks UPDATE/DELETE. No historic rewrite.
2. Implement bounded, tenant-scoped audit list and admin route using existing scope and pagination conventions. Test filter validation, stable cursor, data projection, authorization and two-org isolation.
3. Implement response-level sanitized failure operator event and fixed sensitive-route failure mapping with best-effort org insert. Test 401/403/404/4xx/5xx, no tenant before resolution, sensitive redaction, duplicate/no-op handling, and audit-store outage without response masking.
4. Build server-rendered admin history page with filters and pagination; test browser access and filter persistence, manually verify and capture screenshots.
5. Extend `apps/api/src/tenant-isolation.integration.test.ts` route coverage and replace `audit records` todo with positive and negative checks. Update docs/security, learning note, and an ADR only if a lasting new architectural choice not already captured by the existing audit ADR/spec is introduced.
6. Run repo checks (`task check`, `task test:integration`, browser tests as applicable, `task fallow`), verify failure injection and trusted-proxy IP behavior in the running system, review security/log redaction, and record measured values or unknowns. No commits/pushes/PR without explicit instruction.

## Open questions and assumptions to validate

- **Unknown:** failure volume, data/log retention, and production latency/recovery objectives. API/security owner must set retention and monitoring thresholds before production rollout using measured event rate; do not claim production readiness without them.
- **Verified locally:** `apps/api/src/audits.integration.test.ts` exercises trusted and untrusted forwarding behavior through a running Fastify app; untrusted forwarding headers do not replace the socket IP. **Assumed in deployment:** actual proxy topology and `TRUSTED_PROXIES` configuration; verify before relying on client-IP attribution in production.
- **Verified locally:** existing append-only trigger, successful transactional audit writes, metadata exclusion, failure-path behavior, and SENTRA-21 audit isolation cases via `task api:test:integration` (237 passed, 23 skipped). `task web:test:e2e` passed all 14 browser tests against the local stack; screenshot: `screenshots/1-filtered-history.png`. The screenshot and other changes remain uncommitted.
