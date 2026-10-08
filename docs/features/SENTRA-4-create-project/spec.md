# SENTRA-4: Create a project

- Status: Implemented, in review
- YouTrack: http://localhost:8080/issue/SENTRA-4 (Project & Asset Management, P1, size S)
- Owner: Brian Oktavec

## Problem and outcome

- **Who/why:** The organization is the tenant boundary (SENTRA-2) and now has roles (SENTRA-3). Members need a product boundary underneath it, so a specific application's dependencies and findings can be grouped. SBOM upload, findings, and investigations (later stories) will hang off a project.
- **Done means:** Any member of an organization can create a project from the web app or API, see the org's projects in a list, and open one by its slug. Anyone outside the org gets "not found". Creation writes an audit event atomically.

## Scope

- In scope:
  - Migration `006`: `projects` table.
  - API: `POST /v1/orgs/:orgId/projects`, `GET /v1/orgs/:orgId/projects` (cursor pagination), `GET /v1/orgs/:orgId/projects/by-slug/:slug`.
  - Atomic creation: project and `project.created` audit event in one transaction.
  - Web: project list with empty state and create form on `/orgs/<slug>`; minimal project page at `/orgs/<slug>/projects/<project-slug>`.
  - Logs, metrics, tests, learning note.
- Out of scope (future work):
  - Role-gated creation, per-org project cap (any member may create; no number is invented).
  - Rename, archive, delete, slug history.
  - Read by project UUID; cross-org project listing.
  - Description, type, or repository metadata (a project may later be a repo, app, service, or environment).
  - Anything inside a project (SBOM upload, findings).
- Dependencies and related stories:
  - Depends on SENTRA-2 (done): `TenantContext`, `scopeTo`, `audit_events`, validation and cursor helpers.
  - Uses SENTRA-3 roles only to the extent that both roles are allowed.
  - SENTRA-20 (audit read) will see `project.created`; SENTRA-21 will include projects in the cross-tenant regression suite.

## Decisions and alternatives

No third-party behavior beyond the existing stack (Fastify, `pg`, Next.js server routes) is relied on, so nothing is labeled Verified or Assumed on that front. Postgres behavior (unique violation, rollback) is exercised by integration tests.

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Who may create | Any org member (`admin` or `member`) | Admins only; any member plus a per-org cap | Matches the user story wording; the existing membership check is enough. Cost: a member can add projects and nothing limits how many (cap is future work). |
| Identity and naming | UUID primary key; non-unique name; slug unique within the org | UUID only (no slug); name unique per org | UUID is the key everywhere; the slug gives readable URLs. Names repeat freely as the story requires. Cost: a slug collision is an error path that reveals the slug exists, but only to org members. |
| Slug lifecycle | User-chosen, suggested from the name in the form; immutable; same format and reserved-word rules as orgs | Auto-generated with numeric suffix; renamable with redirects | Reuses validation and the form pattern. Cost: a typo is permanent until a rename story. |
| Retry behavior | Slug already exists in the org with the same name returns `200` with the existing project and no second audit event; any other slug conflict returns `409 slug_taken` | Plain 409; `Idempotency-Key` table | No new table or header; a double-click or network retry succeeds. Leaks nothing: the caller is already a member. |
| List endpoint | Per-org, cursor pagination (`limit` default 50, max 100; order `created_at, id`) | Unpaginated capped list; also a cross-org list | The contract is hard to change after clients depend on it; reuses the org cursor helpers. Cross-org listing has no consumer yet. |
| Fields | `id`, `org_id`, `name`, `slug`, `created_by`, `created_at`, `updated_at` | No `created_by`; optional description | Exactly the story plus cheap provenance. Nothing requires a description yet. |
| Addressing | Org by UUID in the API path (`TenantContext` from `scopeTo`), project by slug within it. Web URLs use both slugs | Project UUID routes | The slug is the only project key a user sees; a UUID read can be added when a story needs it. |
| Unauthorized access | Non-members get `404`, identical to a missing org; a slug unknown in the org gets the same `404` | `403` | Does not reveal whether an org or project exists. |
| Performance targets | No numeric SLO; every query is indexed; measure in SENTRA-26/27 | Set numbers now | `AGENTS.md`: do not invent capacity targets. |

## Architecture and contracts

- **Affected components and ownership:** `apps/api` owns the project model, authorization, and audit. `apps/web` renders the UI and calls the API with the session's bearer token; it contains no authorization logic.
- **Request flow (create):**
  1. The protected route group authenticates; `scopeTo` resolves the caller's membership for `:orgId` into `TenantContext` (non-member: `404`).
  2. Validate the body (name, slug) with the org rules. Invalid input returns `400`.
  3. Begin a transaction. Insert the project with `ON CONFLICT (org_id, slug) DO NOTHING`. If nothing was inserted, read the existing row: same name returns `200` with it; otherwise `409 slug_taken`.
  4. Insert the `project.created` audit event (`target_type` `project`), then commit.
  5. Return `201` with the project.
- **Request flow (read, list):** `scopeTo`, then an indexed query filtered by `org_id` from the `TenantContext`. The slug route filters by `(org_id, slug)`, so a project in another org is simply not found.
- **Storage contract (migration `006_projects.sql`):**
  - `projects(id uuid pk default gen_random_uuid(), org_id uuid not null references organizations(id), name text not null check (char_length(name) between 1 and 80), slug text not null check (same pattern as organizations), created_by uuid not null references users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (org_id, slug))`.
  - Index `projects(org_id, created_at, id)` for the list.
  - `audit_events` is unchanged (`target_type` is free text); the TypeScript `AuditEvent.targetType` union gains `"project"`.
- **API contracts** (errors use the existing RFC 9457 bodies from `@sentra/ts-platform`):

  | Route | Success | Errors |
  | --- | --- | --- |
  | `POST /v1/orgs/:orgId/projects` `{name, slug}` | `201` project `{id, orgId, name, slug, createdAt}`; `200` on the idempotent retry | `400` invalid input, `401`, `404` (non-member or unknown org), `409 slug_taken` |
  | `GET /v1/orgs/:orgId/projects?limit&cursor` | `200` `{items, nextCursor}` | `400` bad cursor or limit, `401`, `404` |
  | `GET /v1/orgs/:orgId/projects/by-slug/:slug` | `200` project | `401`, `404` (non-member, unknown org, or unknown slug) |

- **Compatibility and migration:** additive migration; no existing contract changes.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | **Unknown.** Create is rare; list and by-slug run on org and project page loads | No target invented | Measure in SENTRA-26/27 |
| Concurrent users or jobs | **Unknown** | No target invented | Concurrency tests check correctness, not capacity |
| Data size and growth | One row per project plus one audit row; unbounded per org (no cap) | Cap is future work | Revisit when real usage exists |
| Latency or throughput target | **Unknown** | Every query uses `(org_id, slug)` or `(org_id, created_at, id)` | Check query plans in tests; baseline in SENTRA-26 |
| Availability and recovery target | **Unknown.** Needs only Postgres; no new dependency | Design property, not an SLO | Readiness already checks Postgres |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Invalid name or slug (empty, too long, control characters, bad format, reserved word) | `400` with a generic problem body | Unit tests; API test |
| Same name, different slug, in one org | Two projects created | API integration test |
| Slug taken in this org by a different name | `409 slug_taken`; UI shows an inline error on the slug field | API integration test; Playwright |
| Same slug in two different orgs | Both succeed | API integration test |
| Retry or double-submit (same slug and name) | `200` with the existing project; exactly one row and one audit event | API integration test (sequential and parallel) |
| Two members create the same slug at once | Exactly one `201`; the other gets `409` or the idempotent `200` | Concurrency test against Postgres |
| Audit insert fails after the project insert | Whole transaction rolls back: no project row | Integration test with a forced failure |
| Postgres unavailable | `5xx` generic problem body; `/readyz` reports not ready | Integration test |
| Non-member lists, reads, or creates in an org | `404`, identical to a nonexistent org; no row written | API integration tests |
| Project slug looked up through a different org | `404` | API integration test |
| Client sends `orgId` or `created_by` in the body | Ignored; tenant and actor come from the checked context | API test |
| Bad or tampered cursor | `400`; another org's projects never appear | API integration test |
| Web: non-member opens `/orgs/<slug>` or a project URL | Standard not-found page | Playwright |
| Web: unauthenticated access | Redirect to sign-in (existing behavior) | Playwright |

## Security, observability, and rollout

- **Authorization, tenant isolation, sensitive data, and abuse limits:**
  - Authorization is server-side; the web app only displays results.
  - Tenant ID comes from the route, is checked against `memberships`, and becomes `TenantContext`; every project query filters by `tenantContext.orgId`. Body tenant fields are ignored.
  - Non-members cannot distinguish "exists" from "does not exist".
  - Audit rows carry the internal user UUID and the project slug only; no email or token.
  - No per-org project cap (future work). The existing failed-auth limiter is unchanged.
- **Logs, metrics, traces, and alerts:**
  - Logs: `project_created` (`orgId`, `projectId`, `userId`) and `project_create_rejected` (reason: `invalid`, `slug_taken`), with the correlation ID; `orgId` is already on the request logger via `scopeTo`.
  - Metric: `project_create_outcomes_total{outcome}` (created, idempotent, invalid, slug_taken).
  - No alerts (SENTRA-23).
- **Rollout, migration, rollback, operational owner:** migration `006` runs on API startup via the existing `migrate`. Rollback is dropping `projects` (no data worth keeping yet). Owner: Brian Oktavec.

## Acceptance criteria

- [x] A member (`admin` or `member`) can create a project in their organization through the web UI and the API.
- [x] A project has a UUID, name, org ID, `created_by`, and timestamps, plus a slug unique within the org; names need not be unique.
- [x] `GET /v1/orgs/:orgId/projects` returns only that org's projects, with cursor pagination, and the org page lists them with an empty state.
- [x] A user cannot list, read, or create projects in an org they do not belong to; the response is the same `404` as a nonexistent org.
- [x] Project creation writes a `project.created` audit event in the same transaction; a retried create yields one project and one event.
- [x] Outcomes are logged and counted.

## Verification

- **Manual checks and expected results:**
  - Bring up the local stack, sign in, and open an org. The empty state shows a create button.
  - Create "Web App"; the slug is suggested as `web-app`. You land on `/orgs/<org>/projects/web-app`.
  - Go back to the org page. The list shows the project.
  - Create another project with the slug `web-app`. An inline conflict error appears. Create one named "Web App" with slug `web-app-2`; both are listed.
  - Sign in as a user outside the org and open the project URL. The not-found page matches a nonexistent URL.
  - Sign in as a plain `member` of the org and create a project. It succeeds.
  - Query `audit_events`. One `project.created` row per created project.
- **Automated tests and what they prove:**
  - Unit: project input validation (shared with org rules) and cursor reuse.
  - API integration (real Postgres): every row of the edge-case table, including cross-org access, per-org slug scope, idempotent retry, parallel same-slug creates, and rollback on audit failure.
  - Playwright e2e (`apps/web/e2e/projects.spec.ts`): create flow, slug conflict, empty state, list, member (non-admin) create, non-member not-found. Screenshots go under `docs/features/SENTRA-4-create-project/screenshots/`.
- **Load or failure tests:** none beyond the concurrency tests above; capacity is measured in SENTRA-26/27.

## Open questions and assumptions to validate

- No per-org project cap: unbounded growth is accepted for now. Revisit with real usage or when a project-cap story exists.
- Any member can create projects: revisit if an admin-only or configurable policy is needed.
- Project read by UUID is deferred: add when a story (such as SBOM upload) needs a stable ID route.
