# SENTRA-28: Organization invitations

- Status: Implemented, in review
- YouTrack: http://localhost:8080/issue/SENTRA-28 (Identity & Tenant Foundation, size M)
- Owner: Brian Oktavec

## Problem and outcome

- **Who/why:** SENTRA-3 gave organizations roles and membership management but no way to add a person. Admins need to invite someone by email with a chosen role, and the invitee needs to join safely: only the person the invitation was for, signed in with a verified email, may accept.
- **Done means:** An admin can invite an email address as `admin` or `member`, list pending invitations, and revoke one. The invitee opens the accept link, signs in, and joins with the invited role. Every other outcome (wrong email, expired, used, revoked, unknown token) is refused without leaking tenant data. Delivering the link by email is SENTRA-29; until then the API returns the accept token to the admin.

## Scope

- In scope:
  - Migration `004`: `invitations`.
  - API: create, list, and revoke invitations (admin); accept an invitation (any signed-in user holding a valid token).
  - Verified-email check against Zitadel's userinfo endpoint at accept time.
  - Abuse caps in the creating transaction: pending invitations per org, invitations per org per rolling 24 hours, and members per org (enforced at accept).
  - Audit events `invitation.created`, `invitation.revoked`, `invitation.accepted`.
  - Web: invitation form and pending list on the members page; `/invitations/accept` page; sign-in now returns the visitor to the page they asked for.
  - Logs, metrics, tests, learning note.
- Out of scope (future work):
  - Sending the email, outbox, retries (SENTRA-29).
  - Storing the verified profile (name and email) for every user at sign-in. This story reads it only at accept time.
  - Invitation analytics, bulk invites, resend (re-inviting the same email replaces the old invitation).
  - Audit log read API (SENTRA-20) and the cross-tenant regression suite (SENTRA-21).
- Dependencies and related stories:
  - Depends on SENTRA-3 (roles, `requireAdmin`, per-org membership lock, `inTransaction`).
  - Blocks SENTRA-29, which emails the link.

## Decisions and alternatives

Third-party behavior: Zitadel's userinfo endpoint returns `email` and `email_verified` for a session token with the `openid profile email` scopes (**Verified**: the Playwright test accepts an invitation through the real endpoint, and a stranger and an unverified identity are refused). Zitadel access tokens carry no `email` or `name` claim (**Verified** in SENTRA-3 by reading `users` after real sign-ins), which is why the profile is fetched from userinfo.

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Accept rule | Valid token and a signed-in user whose **verified** email equals the invited email (case-insensitive). Verified email comes from the userinfo endpoint, called with the caller's own access token before the transaction | Token alone; email claim in the access token | A leaked or forwarded link is useless to anyone else. The access token has no email, so userinfo is the only reliable source. Cost: one extra network call on accept, which is rare. |
| Token | 32 random bytes, base64url; only the SHA-256 hash is stored (unique index); shown once in the create response | Store the token; sign a token with a secret | A database leak does not leak working links, and there is no secret to manage. Cost: the token cannot be shown again, so a lost link means re-inviting. |
| Single-use and expiry | Status `pending`, `accepted`, or `revoked`; `expires_at` set from `INVITATION_TTL_HOURS` (default 168, an assumption) and checked at accept time | Cleanup job; hard delete | No background job. Rows are kept for audit and for idempotent retries. |
| Re-invite | Inviting an email that already has a pending invitation revokes the old one and creates a new one in one transaction | `409`; update in place | An admin can fix a mistaken role or replace a lost link without a separate resend route. Old token stops working. |
| Concurrency | Creation and acceptance take the org-row lock from SENTRA-3, then count and change | Count without a lock | Caps cannot be exceeded by parallel requests. Cost: invitations and membership changes in one org are serialized. |
| Abuse limits | Per org: pending invitations (default 50), invitations created in 24 hours (default 50), members (default 100); env `MAX_PENDING_INVITATIONS_PER_ORG`, `MAX_INVITATIONS_PER_ORG_PER_DAY`, `MAX_MEMBERS_PER_ORG`. Defaults are assumptions to validate from metrics | Redis rate limiter | Bounded without new infrastructure. Cost: the numbers are guesses. |
| Failure responses | Unknown token `404`; revoked or already used by someone else `410 invitation_unavailable`; expired `410 invitation_expired`; email not verified or different `403 invitation_email_mismatch`. No body includes org, inviter, or invited email | One generic error for everything | The accept page needs to explain what happened. Only a token holder can see these differences, and none carries tenant data. |
| Accept is a POST | The accept page shows a button; accepting is `POST /v1/invitations/accept` with the token in the body | Accept on `GET` | Link previews, scanners, and prefetching must not consume an invitation. |
| Retry | Accepting again as the same user after success returns `200` with the same org and writes nothing | `410` | A double click or retry is harmless. |
| Audit | `target_type` `invitation`, `target_id` the invitation ID, metadata holds the role only (no email, no token) | Include email | Matches SENTRA-2: no email in audit rows. |
| Returning after sign-in | The web proxy remembers a safe same-site path in a short-lived cookie; the callback redirects there | Pass the path in OIDC state | Smallest change that keeps the accept link usable for someone who is not signed in. Only paths starting with a single `/` are accepted, so it cannot redirect off-site. |

## Architecture and contracts

- **Affected components and ownership:** `apps/api` owns invitations, caps, and the verified-email check; `apps/web` renders the UI and forwards the user's token. The API calls the identity provider's userinfo endpoint (a new outbound dependency, with a timeout).
- **Request flow (create):** authenticate, `scopeTo`, `requireAdmin`, validate `{email, role}` (email trimmed and lowercased, 3 to 254 characters, one `@`, no whitespace). In one transaction: lock the org row, re-check the caller is still admin, revoke any pending invitation for that email (audit `invitation.revoked`), count pending invitations and invitations created in 24 hours against the caps, insert the new row, audit `invitation.created`. Return `201` with the token.
- **Request flow (accept):** authenticate; read the bearer token from the request; fetch the caller's profile from userinfo (before any lock; failure is `503`); look up the invitation by token hash. In a transaction: lock the invitation row, then the org row, and decide: accepted by this user means `200` idempotent; revoked, accepted by someone else is `410`; expired is `410`; email not equal to the verified email is `403`; if the user is already a member, mark accepted and return the org; if the org is at the members cap, `403 member_limit_reached`; otherwise insert the membership with the invited role, mark accepted, audit `invitation.accepted`. Returns the org `{id, name, slug, role}`.
- **Storage contract (migration `004_invitations.sql`):** `invitations(id uuid pk, org_id fk, email text lowercase, role admin|member, token_hash bytea unique, invited_by fk users, status pending|accepted|revoked, created_at, expires_at, accepted_by, accepted_at)`; partial unique index on `(org_id, email)` where `status = 'pending'`; index on `(org_id, created_at)`.
- **API contracts** (RFC 9457 bodies):

  | Route | Who | Success | Errors |
  | --- | --- | --- | --- |
  | `POST /v1/orgs/:orgId/invitations` `{email, role}` | admin | `201` `{id, email, role, createdAt, expiresAt, token}` | `400`, `401`, `403 forbidden`, `403 invitation_limit_reached`, `404` |
  | `GET /v1/orgs/:orgId/invitations` | admin | `200` `{items: [{id, email, role, createdAt, expiresAt}]}` (pending, at most the pending cap) | `401`, `403`, `404` |
  | `DELETE /v1/orgs/:orgId/invitations/:invitationId` | admin | `204`, also when it is not pending or does not exist (idempotent) | `401`, `403`, `404` |
  | `POST /v1/invitations/accept` `{token}` | signed-in user | `200` org; `200` on retry | `400`, `401`, `403 invitation_email_mismatch`, `403 member_limit_reached`, `404`, `410`, `503` |

- **Compatibility and migration:** additive migration. No change to existing routes.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | **Unknown.** Invitations are rare admin actions | No target invented | Measure in SENTRA-26/27 |
| Concurrent users or jobs | **Unknown** | No target invented | Concurrency tests check correctness |
| Data size and growth | At most the caps per org; rows are kept after use | Caps are assumptions | Tune from metrics; archive when volume warrants |
| Latency or throughput target | **Unknown.** Accept adds one userinfo round trip | Timeout 3 seconds; token lookup uses a unique index | Baseline in SENTRA-26 |
| Availability and recovery target | **Unknown.** Accept depends on the identity provider; if userinfo is down accept returns `503` and can be retried | Design property | Failure test below |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Member calls any admin-only invitation route | `403`, nothing changes | API integration test |
| Non-member or missing org on any invitation route | Same `404` as a missing org | API integration test |
| Invalid email or role | `400` | Unit and API tests |
| Re-invite the same email | Old invitation revoked, new token issued, old token rejected | API integration test |
| Pending or daily cap reached | `403 invitation_limit_reached`; nothing created | API integration test, parallel creates |
| Accept with the right account | Membership with the invited role, invitation `accepted`, one audit event | API integration test |
| Accept with a different or unverified email | `403 invitation_email_mismatch`; invitation still usable by the right person | API integration test |
| Expired, revoked, or used-by-someone-else token | `410`; unknown or tampered token `404` | API integration test |
| Same user accepts twice, or in parallel | `200` both times; one membership, one audit event | API integration test (parallel) |
| Two users race for one token | Exactly one wins (the email check makes only one eligible); the other is refused | API integration test |
| Org at the members cap | `403 member_limit_reached`; invitation stays pending | API integration test |
| Invitee is already a member | Invitation marked accepted, role unchanged, no new membership | API integration test |
| Identity provider unavailable during accept | `503`; nothing changes; retry works | API integration test |
| Failure after the membership insert (audit fails) | Whole transaction rolls back; invitation stays pending | API integration test with a forced failure |
| Token and email never appear in logs or audit rows | Checked on captured log output and audit metadata | API integration test |
| Web: signed-out visitor opens the accept link | Signs in, lands on the accept page | Playwright |
| Web: wrong account, expired, or used link | Plain explanation, no tenant details | Playwright |

## Security, observability, and rollout

- **Authorization, tenant isolation, sensitive data, and abuse limits:**
  - Management routes use `scopeTo` and `requireAdmin`. Non-members get `404`; members get `403`.
  - The token is a secret: stored only as a hash, never logged, never written to audit rows. It is returned once to the admin who created it, who cannot use it without owning the invited verified email.
  - Accept does not return any organization data until the email check passes.
  - The `return to` cookie accepts only same-site paths.
  - Caps bound email-address enumeration and storage.
- **Logs, metrics, traces, and alerts:**
  - Logs (correlation ID, `userId`, `orgId`): `invitation_created`, `invitation_revoked`, `invitation_accepted` (info); `invitation_rejected` with a `reason` (info); `profile_fetch_failed` (warn).
  - Metrics: `invitation_outcomes_total{outcome}` (created, revoked, accepted, idempotent, mismatch, expired, unavailable, unknown, limit, member_limit), `profile_fetch_failures_total`.
  - No alerts in this story (SENTRA-23).
- **Rollout, migration, rollback, operational owner:** migration `004` runs on API startup. Rollback: drop `invitations`. New env vars: `INVITATION_TTL_HOURS`, `MAX_PENDING_INVITATIONS_PER_ORG`, `MAX_INVITATIONS_PER_ORG_PER_DAY`, `MAX_MEMBERS_PER_ORG`. Owner: Brian Oktavec.

## Acceptance criteria

- [x] An admin can invite an email with the role `admin` or `member`; a member cannot (`403`).
- [x] The token is stored only as a hash, is single-use, and expires after `INVITATION_TTL_HOURS` (default 168).
- [x] An admin can list pending invitations and revoke one.
- [x] Only a signed-in user with a verified email matching the invited address (case-insensitive) can accept; the token alone is not enough.
- [x] Accepting creates the membership and the audit event atomically; retries are idempotent.
- [x] Expired, revoked, used, wrong-email, and unknown tokens are refused without revealing tenant data.
- [x] Caps on pending invitations, invitations per day, and members per org are enforced under concurrency.
- [x] Audit events exist for created, revoked, and accepted.
- [x] The web app has the invitation controls and the accept page, and signed-out invitees return to the accept page after signing in.

## Verification

- **Manual checks and expected results:**
  - As an admin, open the members page, enter an email and role, and submit. An accept link appears once.
  - Open the link in a private window, sign in as a user whose verified email matches. Click Accept: you land on the organization page with the invited role.
  - Open the same link as a different user: you see the mismatch message and nothing about the organization.
  - Revoke a pending invitation and open its link: you see the unavailable message.
- **Automated tests and what they prove:**
  - Unit: email and token validation, hashing, return-path validation.
  - API integration (real Postgres): every row of the edge-case table, with the identity provider's userinfo faked at the outer boundary (a stub function). The fake is the only fake (besides identity); the Playwright test checks the same behavior against the real endpoint.
  - Playwright (real Zitadel, real userinfo): invite, sign-in redirect and accept, mismatch, revoke. Screenshots under `docs/features/SENTRA-28-organization-invitations/screenshots/`.
- **Load or failure tests, if relevant:** parallel creates and parallel accepts; identity provider down.

## Open questions and assumptions to validate

- **Cap defaults (assumed):** 50 pending, 50 per day, 100 members. Tune from metrics.
- **Token in the create response:** kept so an admin can copy the link before SENTRA-29 and as a fallback after it. Revisit if it is judged an unneeded exposure.
- **Profile storage:** the verified profile is read only at accept time; storing name and email for all users at sign-in is a follow-up (the members page still shows "(no name)" for most users until then).
