# SENTRA-2: Create an organization

## What was built

- **Three tables** (migration `002`): `organizations` (UUID id, display name, unique slug), `memberships` (org, user, role) and `audit_events` (append-only).
- **API** (`apps/api`): `POST /v1/orgs`, `GET /v1/orgs` (cursor-paginated), `GET /v1/orgs/:orgId` and `GET /v1/orgs/by-slug/:slug`.
- **The membership check** (`resolveTenant` in `orgs.ts`): the single way an org-scoped route obtains a `TenantContext { orgId, userId, role }`.
- **Web** (`apps/web`): a home page listing your organizations, a create form that suggests a slug from the name, and a minimal organization page.

## Why it is designed this way

- **The organization is the tenant, and the UUID is the tenant key.** The display name can repeat and the slug is only for URLs, so neither is ever used to scope data. A later slug rename touches no tenant data.
- **Memberships, not an owner column.** "Creator becomes admin" is a membership with role `admin`. SENTRA-3 adds roles to the same table instead of migrating away from an `owner_user_id` column.
- **Tenant context is built by the server, never read from the request.** Routes call the membership check, and domain code receives the result. A request body that says `orgId` or `role: owner` is ignored.
- **A non-member sees "not found".** Missing org, malformed ID, unknown slug and non-membership all return the same 404, so callers cannot probe which organizations exist.
- **Create is atomic.** The organization, the admin membership and the audit event commit together or not at all, so there is never an organization without its audit record, or an audit record for an organization that does not exist.
- **Audit rows are append-only in the database.** A trigger rejects UPDATE and DELETE, so product code cannot rewrite history even by mistake.
- **A retry is not an error.** A slug conflict where you are already the admin of a same-named org returns the existing org with 200 and writes no second audit event. Any other conflict is a 409.

## Alternatives considered

- `owner_user_id` only, or the full member and role model now (SENTRA-3's job).
- Unique display names (squattable, leaks names) or auto-generated slugs (surprising URLs).
- Slug in API routes, or UUID-or-slug in one parameter: ambiguous, and it makes the slug a tenant key.
- Audit as a log line (not durable or queryable) or a transactional outbox to a queue (infrastructure with no requirement yet).
- An `Idempotency-Key` header with a stored-keys table: correct but heavier than one endpoint needs.
- Postgres row-level security now: strong defense in depth, but a lot of machinery for three small tables. Revisit in SENTRA-21.

## Tradeoffs made

- Slugs are permanent for now, so a typo sticks until a rename story exists. A 409 on a slug reveals that the slug is in use.
- The cap of 5 organizations per user is a guess. It bounds slug squatting but does not limit creation speed.
- The audit trigger stops product code and ordinary SQL, but the table owner can still drop it. Separate migration and application database roles are the real fix.
- Nothing in the database stops a future query from forgetting `org_id`. The pattern (take a `TenantContext`) makes that hard to do by accident, and SENTRA-21 will test it.

## Scaling implications

- Every query is indexed: unique `slug`, primary key `(org_id, user_id)`, and `memberships(user_id, created_at, org_id)` for the list.
- The list uses keyset (cursor) pagination, so a page costs the same however many organizations a user belongs to. Offset pagination would get slower as the offset grows.
- Create locks one user row for the length of a short transaction. It serializes one user's creates, not different users'.
- Audit rows grow with activity in the operational database. Partition or archive them when volume warrants it (SENTRA-20 and later).

## Important failure and security considerations

- **Races.** Two users creating the same slug: the unique index lets exactly one win. One user creating many organizations in parallel: the row lock plus a count inside the transaction keeps them under the cap. Both are tested with real parallel requests against Postgres.
- **Lock choice.** `FOR UPDATE` on the user row also conflicts with the lock a foreign-key insert takes, which hid the missing explicit lock from our own test. `FOR NO KEY UPDATE` is enough and made the race test fail when the lock was removed.
- **No information leaks.** Denied access is logged with the user and route, but the response is identical to "does not exist".
- **Cursor input is untrusted.** A tampered cursor is validated and rejected with 400 rather than reaching SQL.

## Key concepts to understand

- Tenant isolation as a server-built context rather than a filter you remember to add.
- Why "404 for non-members" is a security property, not just a convention.
- Keyset pagination and why its ordering needs a unique tiebreaker (`created_at, org_id`).
- Natural idempotency (using a unique key you already have) versus an idempotency-key table.
- Row-lock serialization inside a transaction, and what `ON CONFLICT DO NOTHING` does when another transaction is mid-insert (it waits for that transaction to finish).
- Why a cap check that counts after the insert still lets an idempotent retry through.
