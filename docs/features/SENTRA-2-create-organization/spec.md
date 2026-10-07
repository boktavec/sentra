# SENTRA-2: Create an organization

- Status: Implemented, in review
- YouTrack: http://localhost:8080/issue/SENTRA-2 (Identity & Tenant Foundation, P0, size M)
- Owner: Brian Oktavec

## Problem and outcome

- **Who/why:** The organization is Sentra's tenant boundary. Projects, SBOMs, findings, investigations, and audit records must all belong to one. SENTRA-1 gave us a verified user; nothing yet says what that user may see. This story creates the tenant model and the first reusable tenant-authorization pattern that SENTRA-3, 4, 5, 20, and 21 build on.
- **Done means:** A signed-in user can create an organization from the web app, becomes its admin, and can list and open the organizations they belong to. Anyone else gets "not found" for it. Creation writes an audit event atomically. Every org-scoped backend operation receives a server-built tenant context, never a raw ID from the client.

## Scope

- In scope:
  - Migration `002`: `organizations`, `memberships`, `audit_events`.
  - API: `POST /v1/orgs`, `GET /v1/orgs` (cursor pagination), `GET /v1/orgs/:orgId`, `GET /v1/orgs/by-slug/:slug`.
  - A shared membership check that produces `TenantContext { orgId, userId, role }`, used by every org-scoped route.
  - Atomic creation: organization, admin membership, and audit event in one transaction.
  - Per-user cap on organizations where the user is admin.
  - Web: home list, `/orgs/new` form, minimal `/orgs/<slug>` page.
  - Logs, metrics, tests, learning note.
- Out of scope (future work):
  - `member` role, invitations, role-gated operations, membership changes (SENTRA-3).
  - Audit log read API and UI (SENTRA-20); audit retention or archiving.
  - Slug rename and slug history; organization deletion or transfer.
  - Postgres row-level security (revisit in SENTRA-21).
  - Per-user creation rate limiting; separate migration and app database roles.
  - Projects and anything inside an organization (SENTRA-4).
- Dependencies and related stories:
  - Depends on SENTRA-1 (done): `request.user`, `users` table, `@sentra/ts-platform`, metrics module.
  - Unblocks SENTRA-3, 4. SENTRA-20 reads the `audit_events` table defined here. SENTRA-21 will build the full cross-tenant regression suite on the pattern here.
  - Story and spec updates: the MVP backlog should note UI work where it makes sense (this story now includes a minimal UI). Update `docs/product/mvp-user-stories.md` and YouTrack after this spec is approved.

## Decisions and alternatives

No third-party behavior beyond SENTRA-1's stack (Fastify, `pg`, Next.js server routes) is relied on, so nothing is labeled Verified or Assumed on that front. Postgres behavior (unique-violation `23505`, `SELECT ... FOR UPDATE`, triggers) will be exercised by the integration tests.

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Membership model | `memberships(org_id, user_id, role)` with role constrained to `admin` for now; creator inserted as admin | `owner_user_id` column only; full member and role model now | Satisfies "creator becomes admin" with the schema SENTRA-3 needs. Cost: SENTRA-2 and 3 share a schema, so the role constraint must be easy to widen. |
| Identity and naming | UUID primary key; non-unique display name; globally unique slug | UUID + name only; unique name | UUID is the tenant key everywhere. A slug gives readable web URLs. Cost: slug collisions are an error path and a 409 reveals that a slug exists (accepted: slugs are not secret). |
| Slug lifecycle | User-chosen at creation (suggested from the name in the form); immutable; `[a-z0-9-]`, 3–40 chars, no leading or trailing hyphen, reserved words; stored lowercase with a unique index | Auto-generated with suffix; renamable with redirects | Smallest design that avoids a history table. Cost: a typo is permanent until a rename story. |
| API addressing | Routes use the UUID; `GET /v1/orgs/by-slug/:slug` is membership-checked. Tenant context, logs, audit, and metrics use the UUID only | Accept UUID or slug in one param; slug as tenant key | No ambiguity (a 36-char slug can look like a UUID); a future rename touches no tenant data. Cost: one extra lookup when a web page loads. |
| Audit storage | `audit_events` table in Postgres, inserted in the same transaction as the org and membership; append-only enforced by a trigger that rejects UPDATE and DELETE | Log line only; transactional outbox to a queue | No gaps between the org and its audit record; immutability enforced in the database. Cost: audit volume lives in the operational DB (partition or archive later). The trigger can be bypassed by a superuser or table owner, so separate DB roles are a future hardening step. |
| Abuse limit | Cap on orgs where the user is admin, default **5** (assumption), env `MAX_ORGS_PER_USER`, checked in the creation transaction after locking the user row | None; cap plus Redis rate limit | Bounded squatting and no Redis dependency, and parallel creates cannot exceed the cap. Cost: 5 is a guess and creation speed is not limited. |
| Retry behavior | Natural idempotency: slug conflict where the caller is already admin of that org and the name matches returns `200` with the existing org and no second audit event; any other conflict returns `409` | Plain 409; `Idempotency-Key` table | No new table or header; leaks nothing because the caller is already a member. |
| Tenant propagation | Shared membership check builds `TenantContext`; domain functions accept it instead of a raw `orgId`. `orgId` is added to the request logger, audit events, and relevant metric labels | Postgres RLS now; log and audit only | Hard to call a domain function without a checked context, and easy to read and test. Cost: nothing in the database stops a query that omits `org_id` (RLS revisited in SENTRA-21). |
| Unauthorized access | Non-members get `404` with the standard not-found problem body, same as a missing org (including malformed IDs and unknown slugs) | `403` | Does not reveal whether an organization exists. |
| List endpoint | Cursor pagination from the start (`limit` default 50, max 100; order `created_at, id`); indexed queries | Fixed cap, no pagination | Membership counts become unbounded in SENTRA-3; the contract is hard to change after clients depend on it. |
| Web flow | Home list with empty state, `/orgs/new`, `/orgs/<slug>`; non-member sees the standard not-found page | Auto-redirect by org count; create modal only | Three simple routes and a landing place that SENTRA-4 can fill. |
| Performance targets | No numeric SLO; every query indexed; measure in SENTRA-26/27 | Set numeric targets now | `AGENTS.md`: do not invent capacity targets. |

## Architecture and contracts

- **Affected components and ownership:** `apps/api` owns the tenant model, authorization, and audit. `apps/web` renders the UI and calls the API with the session's bearer token (as in SENTRA-1). The web app contains no authorization logic. `packages/ts-platform` is unchanged unless a shared helper emerges.
- **Request flow (create):**
  1. The protected route group authenticates and sets `request.user`.
  2. Validate the body (name, slug). Invalid input returns `400`.
  3. Begin a transaction and lock the user row (`SELECT ... FOR NO KEY UPDATE`). This serializes one user's creates. `NO KEY UPDATE` is enough and, unlike `FOR UPDATE`, does not block other rows' foreign-key checks against the user.
  4. Insert the organization with `ON CONFLICT (slug) DO NOTHING`. If nothing was inserted, apply the idempotency rule: `200` with the existing org, or `409 slug_taken`.
  5. Insert the admin membership, then count the user's admin memberships. Over `MAX_ORGS_PER_USER` returns `403 org_limit_reached` and rolls everything back. The count runs after the insert so that a retry at the cap still reaches the idempotent path in step 4.
  6. Insert the `org.created` audit event, then commit.
  7. Return `201` with the organization, including the caller's role.
- **Request flow (org-scoped read):** authenticate, then the shared check looks up the membership for `(orgId, user.id)`. No membership returns `404`. Otherwise build `TenantContext` and attach `orgId` to the logger.
- **Storage contracts (migration `002_organizations.sql`):**
  - `organizations(id uuid pk default gen_random_uuid(), name text not null, slug text not null unique, created_by uuid not null references users(id), created_at timestamptz not null default now())`; checks on slug format and name length.
  - `memberships(org_id uuid references organizations(id), user_id uuid references users(id), role text not null check (role in ('admin')), created_at timestamptz not null default now(), primary key (org_id, user_id))`; index on `memberships(user_id, created_at, org_id)`.
  - `audit_events(id uuid pk default gen_random_uuid(), org_id uuid not null references organizations(id), actor_user_id uuid not null references users(id), action text not null, target_type text not null, target_id uuid not null, correlation_id text, metadata jsonb not null default '{}', created_at timestamptz not null default now())`; index on `(org_id, created_at)`; trigger rejecting UPDATE and DELETE.
- **API contracts** (errors use the existing RFC 9457 bodies from `@sentra/ts-platform`):

  | Route | Success | Errors |
  | --- | --- | --- |
  | `POST /v1/orgs` `{name, slug}` | `201` org `{id, name, slug, role, createdAt}`; `200` on the idempotent retry | `400` invalid input, `401`, `403 org_limit_reached`, `409 slug_taken` |
  | `GET /v1/orgs?limit&cursor` | `200` `{items, nextCursor}` of the caller's orgs | `400` bad cursor or limit, `401` |
  | `GET /v1/orgs/:orgId` | `200` org | `401`, `404` (missing, malformed, or non-member) |
  | `GET /v1/orgs/by-slug/:slug` | `200` org | `401`, `404` (same rule) |

- **Compatibility and migration:** additive migration on a greenfield schema. Existing `/v1/me` is unchanged. `memberships.role` check widens in SENTRA-3.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | **Unknown.** Create is rare; list and by-slug run on most web page loads | No target invented | Measure in SENTRA-26/27 |
| Concurrent users or jobs | **Unknown** | No target invented | Concurrency tests below check correctness, not capacity |
| Data size and growth | A few rows per organization; one audit row per creation. At most 5 admin orgs per user (assumed) | Cap is an assumption | Tune `MAX_ORGS_PER_USER` from creation metrics |
| Latency or throughput target | **Unknown** | All queries use a unique, primary-key, or `user_id` index | Check query plans in tests; baseline in SENTRA-26 |
| Availability and recovery target | **Unknown.** Needs only Postgres; no new dependency | Design property, not an SLO | Readiness already checks Postgres |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Invalid name or slug (empty, too long, bad characters, reserved word, leading or trailing hyphen, uppercase) | `400` with a generic problem body; uppercase slugs are rejected, not silently changed | Unit tests for validation; API test |
| Slug already taken by another organization | `409 slug_taken`; UI shows an inline error on the slug field | API integration test; Playwright |
| Retry or double-submit of the same create | `200` with the existing org; exactly one org and one audit event | API integration test (sequential and parallel) |
| Two users create the same slug at once | Exactly one succeeds; the other gets `409` | Concurrency test against Postgres |
| One user fires parallel creates at the cap | Never exceeds `MAX_ORGS_PER_USER` | Concurrency test against Postgres |
| Failure after the org insert (membership or audit insert fails) | Whole transaction rolls back: no org, membership, or audit row | Integration test with a forced failure |
| Postgres unavailable | `5xx` generic problem body; `/readyz` reports not ready | Integration test (as in SENTRA-1) |
| Non-member reads an org by UUID or by slug | `404`, identical to a nonexistent org | API integration tests (both routes) |
| Malformed UUID, unknown slug | `404` | API integration test |
| List returns only the caller's orgs; bad or tampered cursor | Other users' orgs never appear; bad cursor returns `400` | API integration tests |
| Client sends an `orgId` or tenant field in the body | Ignored; tenant comes only from the checked context | API test |
| Update or delete of an audit row | Rejected by the database trigger | Integration test |
| Web: non-member opens `/orgs/<slug>` | Standard not-found page | Playwright |
| Web: unauthenticated access to `/orgs/*` | Redirect to sign-in (existing SENTRA-1 behavior) | Playwright |

## Security, observability, and rollout

- **Authorization, tenant isolation, sensitive data, and abuse limits:**
  - Authorization is server-side in the API. The web app only displays results.
  - Tenant ID comes from the route, is checked against `memberships`, and is turned into `TenantContext`. Request-body tenant IDs are ignored.
  - Non-members cannot distinguish "exists" from "does not exist". Slug conflicts do reveal that a slug is in use (accepted).
  - Audit rows contain no tokens or email. Actor is the internal user UUID.
  - Cap on organizations per user. The existing per-IP failed-auth limiter is unchanged.
- **Logs, metrics, traces, and alerts:**
  - Logs: `org_created` (`orgId`, `userId`), `org_create_rejected` (reason: `invalid`, `slug_taken`, `limit`) at info, `tenant_access_denied` (`userId`, route) at warn, and `tenant_resolved` at debug, all with the correlation ID. `orgId` joins the request logger for org-scoped routes.
  - Metrics: `org_create_outcomes_total{outcome}` (created, idempotent, invalid, slug_taken, limit), `tenant_access_denied_total`.
  - No alerts in this story (SENTRA-23).
- **Rollout, migration, rollback, operational owner:** greenfield migration `002` runs on API startup via the existing `migrate`. Rollback is dropping the three tables (no data worth keeping yet). `MAX_ORGS_PER_USER` is read by `config.ts` with a default of 5; like the API's other tunables it is not listed in `.env.example`. Owner: Brian Oktavec.

## Acceptance criteria

- [x] An authenticated user can create an organization through the web UI and the API.
- [x] The organization has a UUID that is independent of its name; the display name is not unique; the slug is unique, validated, and immutable.
- [x] The creating user becomes an `admin` through a persisted `memberships` row.
- [x] Organization, membership, and ownership are persisted in Postgres, atomically with the audit event.
- [x] A user cannot read an organization they do not belong to, by UUID or by slug. Both return the same `404` as a nonexistent one, and the web shows the not-found page.
- [x] `GET /v1/orgs` returns only the caller's organizations, with cursor pagination.
- [x] Creation writes an `org.created` audit event that cannot be updated or deleted.
- [x] A retried or double-submitted create yields one organization and one audit event.
- [x] A user cannot exceed `MAX_ORGS_PER_USER`, even with parallel requests.
- [x] Org-scoped operations receive a `TenantContext` built by the shared membership check, and `orgId` appears in logs and audit events.
- [x] Outcomes are logged and counted.

## Verification

- **Manual checks and expected results:**
  - Bring up the local stack and sign in. The home page shows the empty state with a create button.
  - Create an organization. Name "Acme", slug suggested as `acme`. You land on `/orgs/acme` showing the name, slug, and role `admin`.
  - Go back home. The list shows Acme.
  - Create a second organization with the slug `acme`. An inline conflict error appears.
  - Sign in as a second user and open `/orgs/acme`. You see the not-found page, identical to `/orgs/does-not-exist`.
  - Query `audit_events` in Postgres. One `org.created` row exists for Acme. An UPDATE or DELETE on it fails.
  - Create organizations until the cap is hit. The next attempt is refused with a clear message.
- **Automated tests and what they prove:**
  - Unit: slug and name validation, reserved words, cursor encode and decode.
  - API integration (real Postgres): every row of the edge-case table above, including cross-user access on both read routes, the idempotent retry, parallel slug and cap races, rollback on failure, and the audit trigger.
  - Playwright e2e: create flow, slug conflict, empty state, list, non-member not-found, unauthenticated redirect. Screenshots go under `docs/features/SENTRA-2-create-organization/screenshots/`.
- **Load or failure tests, if relevant:** none beyond the concurrency tests. Capacity is measured in SENTRA-26/27.

## Open questions and assumptions to validate

- **Name rules (assumed):** trimmed, 1–80 characters, no control characters. Confirm or change before implementation.
- **Reserved slugs (assumed):** `admin`, `api`, `new`, `settings`, `orgs`, `auth`, `login`, `logout`, `me`, `www`, `app`. Confirm or extend.
- **Cap value (assumed):** `MAX_ORGS_PER_USER=5`. Tune from metrics.
- **Audit immutability:** the trigger protects against product code and ordinary SQL but not against the table owner. The API uses one connection role for migrations and queries today. Splitting roles is a future hardening story. Decide whether to file it.
- **Cap error status:** `403 org_limit_reached` chosen; reconsider if the web error handling prefers `409` or `422`.
- **Backlog updates:** SENTRA-2 now lists its UI criteria in YouTrack and `docs/product/mvp-user-stories.md`. Other stories likely need UI criteria too (SENTRA-3 members and roles, SENTRA-4 projects, SENTRA-15 and 16 findings, SENTRA-20 audit log). That is left for the owner to confirm story by story.
- **Resolved during implementation:** the cap error stayed `403 org_limit_reached`. Name and reserved-slug defaults stayed as listed above.
