# SENTRA-3: Organization roles and membership management

## What was built

- **A second role.** Migration `003` widens `memberships.role` from `admin` to `admin` or `member`.
- **Three member routes** (`apps/api`): list members, change a member's role, and remove a member or leave.
- **`requireAdmin`** in `org-routes.ts`: called after the membership check, it turns "caller is a member, but not an admin" into a generic `403`.
- **Last-admin protection**, with an audit event for every change, in `members.ts`.
- **A members page** (`apps/web`) at `/orgs/<slug>/members`: admins see emails and role controls, members see names and a Leave button.

## Why it is designed this way

- **Authorization reads the role from the database on every request.** Nothing about a user's role is cached or put in the token, so a demotion or removal takes effect on the very next request.
- **`404` for strangers, `403` for members.** A non-member must not learn that an org exists, so they get the same `404` as a missing org. A member already knows the org exists, so a `403` leaks nothing and gives clients a clear signal.
- **One lock per org makes the last-admin rule safe.** Every membership change locks the organization row, changes the data, then counts the remaining admins. Zero means roll back with `409`. Without the lock, two admins demoting each other at once could both see "another admin exists" and both succeed.
- **The caller's role is checked again under the lock.** The first check happens before the lock, so an admin who was demoted in the meantime could still finish an admin-only change. Re-reading the role after taking the lock closes that gap.
- **Delete is idempotent.** Deleting someone who is not a member returns `204` and writes nothing, whether they were removed earlier, never joined, or belong to another org. A retried request is a success and nothing leaks.
- **Emails are for admins only.** The API omits the `email` key for member callers instead of sending it and hoping the UI hides it.
- **Every change is audited in the same transaction**, reusing the append-only `audit_events` table from SENTRA-2.

## Alternatives considered

- Roles in the access token or a role cache: faster, but stale after a demotion.
- `404` for every denial: hides routes, but members cannot tell "not allowed" from "missing".
- A deferred constraint trigger or advisory lock for the last admin: more machinery than one row lock.
- A separate `POST .../leave` route: more surface for the same rule (self or admin).
- Postgres row-level security: still SENTRA-21.

## Tradeoffs made

- All membership changes in one org are serialized. That is fine for a rare admin action and would only matter at a write rate we do not have.
- Nothing stops a new admin-only route from forgetting `requireAdmin`. The pattern is small and the integration tests check every route, but a route-level default would be stronger if forgetting becomes likely.
- A mistyped user ID on delete looks like success. Nothing changed, so that is acceptable.
- A user who already left gets `404` on a repeated leave, because they are no longer a member. The web app treats that as success.

## Scaling implications

- Every query uses the `(org_id, user_id)` primary key or `memberships_user_idx`. The member list is keyset-paginated, so a page costs the same however large the org is.
- The org-row lock is held for a short transaction. Different orgs never block each other.
- `NO KEY UPDATE` is used rather than `UPDATE`, so the foreign-key checks that other inserts make against the org row do not wait on it.

## Important failure and security considerations

- **Races.** Two admins demoting each other, or both leaving, leave exactly one admin. The tests run these in parallel and, when the lock is removed on purpose, fail.
- **Rollback.** If the audit insert fails, the role change is rolled back too.
- **No cross-tenant leaks.** A user from another org gets the same response as for a missing user, and nothing in logs or bodies names the other org's members.
- **Known gap.** Zitadel access tokens carry no name or email, so the members page shows "(no name)" for real users until sign-in stores a profile. SENTRA-28 needs this for invitations.

## Key concepts to understand

- Why a check-then-act sequence needs a lock, and why the check must be repeated after taking it.
- Row locks: `FOR UPDATE` versus `FOR NO KEY UPDATE`, and what each blocks.
- Authorization (what you may do) versus tenant isolation (what you may see), and why they return different status codes.
- Idempotent delete, and the difference between "retry is safe" and "retry returns the same status".
- Why access tokens are a poor place for data that can change (roles) and an unreliable place for profile data.
