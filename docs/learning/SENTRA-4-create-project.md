# SENTRA-4: Create a project

## What was built

Any member of an organization can create a project, list the org's projects, and open one by slug, in the API (`/v1/orgs/:orgId/projects`) and the web app (project list and form on `/orgs/<slug>`, project page at `/orgs/<slug>/projects/<project-slug>`). Creating a project writes a `project.created` audit event in the same transaction.

## Why it is designed this way

- **Reuse the tenant pattern.** Every project route goes through `scopeTo`, which turns the route's org ID into a `TenantContext`. Every project query filters by `tenant.orgId`, and the body is never trusted for tenant or actor. This is the whole isolation story, so it is easy to review and to test.
- **UUID key, slug for humans.** The UUID is what other tables will reference later. The slug is unique per org (not globally), immutable, and only used in URLs, so renaming never touches data.
- **Retries are safe without a new table.** `INSERT ... ON CONFLICT (org_id, slug) DO NOTHING` plus "same name means retry" gives a `200` with the existing project and no second audit event. Concurrent creates of one slug serialize on the unique index, so exactly one wins.
- **Audit in the same transaction.** The project and its audit row commit or roll back together. There is no window with a project that has no audit trail.

## Alternatives considered

- Admins only: stricter, but contradicts the "organization member" story. Any member can create; a policy or cap is future work.
- UUID-only URLs: simpler, but unreadable and no help for users.
- Auto-generated slugs: no conflict errors, but the user loses control and safe generation under races is harder.
- `Idempotency-Key` table: the most correct retry story, but heavier than one endpoint needs.
- Unpaginated list: smaller now, but changing the response shape later breaks clients.

## Tradeoffs and scaling

- No per-org project cap, so a member can create unlimited projects. This is a known gap to close with a real number once there is usage data.
- The list is indexed on `(org_id, created_at, id)` and uses keyset (cursor) pagination, so page cost does not grow with depth. A 409 reveals that a slug exists, but only to members of that org.
- Audit rows live in the operational DB, as in SENTRA-2.

## Failure and security considerations

- A non-member gets the same `404` as a missing org on all three routes, so project and org existence do not leak. A project looked up through the wrong org is also `404`.
- Failure after the project insert (the audit insert) rolls back everything; tested by forcing the audit insert to fail.
- The web form sends the org ID as a hidden field, but the API still checks membership, so tampering with it gains nothing.

## Key concepts

- Keyset pagination vs offset pagination.
- Natural idempotency vs idempotency keys.
- `INSERT ... ON CONFLICT DO NOTHING` and how unique indexes serialize concurrent writers.
- Tenant context built once at the edge, passed to every domain function.
