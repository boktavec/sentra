# SENTRA-3: Organization roles and membership management

- Status: Implemented, in review
- YouTrack: http://localhost:8080/issue/SENTRA-3 (Identity & Tenant Foundation, P0)
- Owner: Brian Oktavec

## Problem and outcome

- **Who/why:** SENTRA-2 made the organization the tenant boundary, but every member is an `admin` and nothing is role-gated. Admins need members with fewer powers, and the system needs one consistent, server-side way to say "only admins may do this" before projects, uploads, and findings (SENTRA-4 onward) arrive.
- **Done means:** An org has `admin` and `member` roles. Admin-only operations return `403` to members. Admins can change roles and remove members, any member can leave, and the last admin can never be removed, even under concurrent requests. Everyone in an org can see who belongs to it. The web app has a members page. Non-members still see the same `404` as for a missing org.

## Scope

- In scope:
  - Migration `003`: widen `memberships.role` to `admin`, `member`.
  - `requireRole` authorization helper on `TenantContext`; a generic `403 forbidden`.
  - API: list members, change a member's role, remove a member or leave.
  - Last-admin protection, concurrency-safe.
  - Audit events for every membership change, in the same transaction.
  - Web: `/orgs/<slug>/members`, linked from the org page.
  - Logs, metrics, tests, learning note, contract doc update for the new error codes.
- Out of scope (future work):
  - Invitations and any way to add a person to an org (SENTRA-28). Until it lands, tests seed `member` rows directly.
  - Invitation email delivery (SENTRA-29).
  - Ownership transfer, org deletion, custom roles, per-resource permissions.
  - Audit log read API and UI (SENTRA-20).
  - Postgres row-level security and the full cross-tenant regression suite (SENTRA-21).
- Dependencies and related stories:
  - Depends on SENTRA-2 (done): `memberships`, `TenantContext`, `resolveTenant`, `audit_events`.
  - Blocks SENTRA-28 and SENTRA-29. SENTRA-28's accept path must take the same per-org lock defined here.
  - Split from the original SENTRA-3 during planning because the full invitation flow with email was too large for one story.

## Decisions and alternatives

No third-party behavior beyond the existing stack (Fastify, `pg`, Next.js) is relied on. Postgres lock behavior is exercised by the integration tests rather than assumed.

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Role model | Two roles, `admin` and `member`, in `memberships.role` with a CHECK constraint | Roles table with permissions; policy engine | Smallest model that meets the story. Cost: adding a third role means a migration and a code change, which is acceptable now. |
| Where authorization lives | `requireRole(tenant, "admin")` called by each route after `resolveTenant`; the role comes from the DB on every request | Role in the session token; Fastify route-level role option; RLS | One checked pattern, easy to read and test. Reading the role per request means demotion and removal take effect immediately. Cost: nothing but the helper stops a route from forgetting to call it. A route-level default is a possible follow-up if forgetting becomes likely. |
| Denial status | Non-members: `404` (unchanged). Members on admin-only ops: `403 forbidden`, generic body | `404` for both | A member already knows the org exists, so `403` leaks nothing across tenants and gives clients a clear signal. Cost: members can learn which routes are admin-only, which has little value to an attacker. |
| Last-admin protection | In one transaction, take `SELECT ... FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, then change the membership, then count remaining admins; zero returns `409 last_admin` and rolls back | Count first with no lock; deferred constraint trigger; advisory lock | The org row lock serializes all membership changes within one org, so two admins demoting each other at once cannot both pass. `NO KEY UPDATE` does not block foreign-key checks from other rows. Cost: membership changes in one org are serialized, which is fine at this write rate. |
| Remove vs leave | One route, `DELETE /v1/orgs/:orgId/members/:userId`; allowed if the caller is that user (leave) or an admin (remove). Audit action is `member.left` or `member.removed` | Separate `POST .../leave` | Fewer routes; one authorization rule: self or admin. Cost: the handler branches on caller == target. |
| Idempotency | Setting a role the member already has returns `200` with no write and no audit event. Deleting a user who is not a member of the org (already removed, never a member, or a member of another org) returns `204` with no write and no audit event | `404` on repeat delete | A retried delete is a success from the client's view, so the web app shows no error. The `204` is the same whether the user was removed earlier or never existed, so it reveals nothing. Cost: a typo'd user ID also looks like success; acceptable because nothing changed. |
| Member visibility | Any member can list members. Members see `userId`, `name`, `role`, `joinedAt`; admins also see `email`. Decided by the owner | Email for everyone; admins only | Admins need email to tell people apart and later to manage invitations; other members only need a name. Cost: the response shape depends on the caller's role, so tests cover both shapes. |
| Audit | Reuse `audit_events`: `member.role_changed` (metadata `{from, to}`), `member.removed`, `member.left`; `target_type` `user`, `target_id` the affected user | Log lines only | Same transactional, append-only guarantees as SENTRA-2. |
| Pagination | Cursor pagination reusing the SENTRA-2 helpers; order `created_at, user_id`; default 50, max 100 | Unpaginated list | Member counts are unbounded until SENTRA-28 caps them; the contract is hard to change later. |

## Architecture and contracts

- **Affected components and ownership:** `apps/api` owns authorization, membership changes, and audit. `apps/web` renders the page and calls the API with the session's bearer token; it contains no authorization logic, and hidden controls are a convenience only. `packages/contracts/error-response.md` gains the new codes.
- **Request flow (change role):**
  1. Authenticate, then `resolveTenant` for the route's `orgId` (non-member: `404`).
  2. `requireRole(tenant, "admin")` (member: `403`, counted and logged).
  3. Validate the body: `role` must be `admin` or `member`. Invalid input returns `400`.
  4. Begin a transaction and lock the org row (`FOR NO KEY UPDATE`).
  5. Load the target's membership. Missing: `404` (the caller is an admin of this org, so this reveals nothing beyond their own org's list). Same role: return `200`, no write.
  6. Update the role, count remaining admins; zero returns `409 last_admin` and rolls back.
  7. Insert the `member.role_changed` audit event, commit, return the member.
- **Request flow (remove or leave):** same steps 1 and 4 to 7, except that step 2 is skipped when the caller is the target (leave), the admin count runs after the delete, and a target who is not a member returns `204` with no write and no audit event (idempotent). Role is checked before the target is looked up, so a member deleting someone else gets `403` regardless. A user who has already left cannot pass step 1 on a retry and gets `404`; the web app treats that `404` on its own leave action as success.
- **Request flow (list members):** `resolveTenant`, no role requirement, cursor query on `memberships` joined to `users`. The `email` field is included only when `tenant.role` is `admin`; for members the key is omitted.
- **Storage contract (migration `003_member_role.sql`):**
  - Drop the `role IN ('admin')` check on `memberships` and add `role IN ('admin', 'member')`. The primary key `(org_id, user_id)` already serves the admin-count query by prefix.
  - Existing rows are all `admin`, so the migration needs no backfill.
- **API contracts** (errors use the RFC 9457 bodies from `@sentra/ts-platform`):

  | Route | Who | Success | Errors |
  | --- | --- | --- | --- |
  | `GET /v1/orgs/:orgId/members?limit&cursor` | any member | `200` `{items: [{userId, name, role, joinedAt, email?}], nextCursor}`; `email` only for admin callers | `400` bad limit or cursor, `401`, `404` |
  | `PATCH /v1/orgs/:orgId/members/:userId` `{role}` | admin | `200` the member | `400`, `401`, `403 forbidden`, `404`, `409 last_admin` |
  | `DELETE /v1/orgs/:orgId/members/:userId` | admin, or the member themself | `204`, also when the target is not a member (idempotent) | `401`, `403 forbidden`, `404` (org not visible to the caller), `409 last_admin` |

  `orgId` and `userId` come from the route. Any tenant or role field in a body is ignored. `/v1/orgs` responses already return the caller's `role`; the type widens to `"admin" | "member"`.
- **Compatibility and migration:** additive; the constraint change is the only schema change. Existing routes and clients are unaffected.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | **Unknown.** The members page is low traffic; role checks add one indexed lookup that `resolveTenant` already does | No target invented | Measure in SENTRA-26/27 |
| Concurrent users or jobs | **Unknown** | No target invented | Concurrency tests check correctness, not capacity |
| Data size and growth | One row per member per org. No cap in this story; SENTRA-28 adds a members-per-org cap | Pagination bounds response size | Revisit when SENTRA-28 sets the cap |
| Latency or throughput target | **Unknown** | All queries use the `(org_id, user_id)` primary key or `memberships_user_idx` | Check query plans in tests; baseline in SENTRA-26 |
| Availability and recovery target | **Unknown.** Needs only Postgres; no new dependency | Design property, not an SLO | Readiness already checks Postgres |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Member calls an admin-only route in their org | `403 forbidden`, generic body, counted in `role_denied_total` | API integration test for every admin route |
| Non-member calls any route for an org | `404`, identical to a missing org (UUID, malformed UUID) | API integration tests |
| Member lists members | `200` with the org's members only; names but no `email` key | API integration test |
| Admin lists members | `200` with the org's members, including `email` | API integration test |
| Client sends `orgId`, `role` on the wrong route, or extra tenant fields in a body | Ignored; tenant and caller role come only from the checked context | API test |
| Invalid role value or missing body | `400` | Unit and API tests |
| `PATCH` target is not a member of this org (including a member of a different org) | `404`, no information about the other org | API integration test |
| `DELETE` target is not a member of this org (already removed, never a member, or in another org) | `204`, no write, no audit event; response identical in all three cases | API integration test |
| Admin changes a member to the role they already have | `200`, no write, no audit event | API integration test |
| Retried `DELETE` after success (admin removing) | `204`, exactly one audit event in total | API integration test |
| Retried self-leave after success | API returns `404` (caller is no longer a member); web treats it as success, no error shown | API integration test; Playwright |
| Demote or remove the only admin; sole admin leaves | `409 last_admin`; nothing changes | API integration test |
| Two admins demote or remove each other at once | Exactly one succeeds; at least one admin remains | Concurrency test against Postgres |
| Admin demotes themself while another admin exists | `200` | API integration test |
| Removed or demoted user's next request | Immediately gets `404` or `403` (role read per request) | API integration test |
| Failure after the membership change (audit insert fails) | Whole transaction rolls back: no membership change, no audit row | Integration test with a forced failure |
| Postgres unavailable | `5xx` generic body; `/readyz` reports not ready | Existing integration pattern |
| Web: member opens members page | Sees the list without admin controls | Playwright |
| Web: member forges an admin request (direct API call) | `403` | API test and Playwright |
| Web: non-member opens `/orgs/<slug>/members` | Standard not-found page | Playwright |

## Security, observability, and rollout

- **Authorization, tenant isolation, sensitive data, and abuse limits:**
  - All authorization is server-side in the API. The role always comes from `memberships` for the authenticated user and the route's org, never from the client or token.
  - Non-members cannot tell whether an org exists. `403` is only ever returned to someone who is already a member.
  - Audit rows hold internal user UUIDs and role values, no email or tokens.
  - The members list exposes names to all members and emails to admins only, always scoped to the caller's org. No cross-tenant data is returned.
  - No new abuse surface: every mutating route needs admin (or is self-leave) and is bounded by the org's membership size. The members cap arrives with SENTRA-28.
- **Logs, metrics, traces, and alerts:**
  - Logs (with correlation ID, `userId`, `orgId`): `role_denied` at warn (route), `member_role_changed`, `member_removed`, `member_left` at info (target user, roles), `membership_change_rejected` at info (reason `last_admin`).
  - Metrics: `role_denied_total`, `membership_changes_total{action}` (role_changed, removed, left), `membership_change_rejected_total{reason}`. `tenant_access_denied_total` is unchanged.
  - No alerts in this story (SENTRA-23).
- **Rollout, migration, rollback, operational owner:** migration `003` runs on API startup through the existing `migrate`. Rollback: restore the old constraint, which requires first changing any `member` rows (none exist until members can be added). Owner: Brian Oktavec.

## Acceptance criteria

- [x] The system supports `admin` and `member` roles in `memberships`.
- [x] Authorization is enforced server-side through `requireRole` on the checked `TenantContext`; role comes from the caller's membership for that org.
- [x] A member gets `403 forbidden` on every admin-only operation.
- [x] A non-member gets the same `404` as for a missing org, on every route; bypass attempts (foreign `orgId`, body-supplied tenant or role fields) are rejected or ignored.
- [x] Any member can list the org's members with cursor pagination; emails are returned to admins only.
- [x] Deleting a user who is not a member succeeds (`204`) with no backend change and no error in the web app.
- [x] An admin can change a member's role and remove a member; any member can leave.
- [x] The last admin can never be demoted, removed, or leave, including under concurrent requests.
- [x] Each membership change writes an audit event in the same transaction; a repeated role set causes no write and no extra audit event.
- [x] A removed or demoted user loses access on their next request.
- [x] Outcomes are logged and counted.
- [x] The web app has a members page; admin controls are hidden from members and the server still enforces.

## Verification

- **Manual checks and expected results** (members are seeded with SQL until SENTRA-28 lands):
  - Sign in as the org's admin and open `/orgs/<slug>/members`. The list shows the admin with controls.
  - Seed a second user as `member`. Sign in as them and open the page: the list shows both names, no emails, and no admin controls. A direct `PATCH` returns `403`. The admin's view shows emails.
  - As the admin, change the member to `admin`, then back to `member`. Each change appears in `audit_events`.
  - As the only admin, try to demote or remove yourself: refused with a clear message.
  - Remove the member. Their next page load shows not-found.
  - Sign in as an unrelated user and open the page: same not-found page as a missing org.
- **Automated tests and what they prove:**
  - Unit: role validation, `requireRole`, cursor handling.
  - API integration (real Postgres): every row of the edge-case table, including cross-user and cross-tenant attempts, idempotency, forced-failure rollback, audit rows, and parallel last-admin races.
  - Playwright e2e: admin and member views, last-admin message, removal, non-member not-found. Screenshots go under `docs/features/SENTRA-3-roles-and-membership/screenshots/`.
- **Load or failure tests, if relevant:** none beyond the concurrency tests. Capacity is measured in SENTRA-26/27.

## Open questions and assumptions to validate

- **Resolved with the owner:** members see names only, admins see names and emails; a repeated `DELETE` is an idempotent `204` with no backend change and no web error.
- **Users with no email or name (found during implementation):** Zitadel access tokens carry neither claim, even though the web app requests the `profile` and `email` scopes, so `users.email` and `users.name` are null for real users today. The members list therefore shows "(no name)" and no email until the profile is stored. This is a SENTRA-1 gap and out of scope here; the Playwright test sets the profile with SQL. SENTRA-28 needs the verified email to match invitations and will read it from Zitadel's userinfo endpoint, which also fixes the display. Follow-up: store name and email at sign-in.
- **Role in cached data:** SENTRA-1's user cache holds only user IDs, not roles, so role changes need no cache invalidation. Re-check if a role cache is ever added.
- **Outbox table owner:** SENTRA-28 or SENTRA-29 creates it (tracked on SENTRA-29).
- **Email-verified claim:** whether the token `Claims` expose it is a SENTRA-28 question, not needed here.
- **Epic field:** SENTRA-28 and SENTRA-29 need the Epic set to Identity & Tenant Foundation in YouTrack (the MCP command could not set it).
