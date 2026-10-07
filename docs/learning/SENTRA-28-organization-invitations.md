# SENTRA-28: Organization invitations

## What was built

- **An `invitations` table** (migration `004`) that stores only the SHA-256 hash of each invitation token.
- **Admin routes**: create, list pending, and revoke invitations. Inviting an address that already has a pending invitation replaces it.
- **`POST /v1/invitations/accept`**: the invitee presents the token. The API checks their verified email against the invitation before anything else happens.
- **Caps** on pending invitations, invitations per day, and members per org.
- **Web**: an invite form and pending list on the members page (admins), the `/invitations/accept` page, and sign-in that returns the visitor to the page they asked for.

## Why it is designed this way

- **The link alone is not enough.** The token proves you were sent the link, not that you are the person it was meant for. Accepting also needs a signed-in user whose *verified* email matches the invited address, so a forwarded or leaked link is useless to anyone else.
- **The verified email comes from the identity provider's userinfo endpoint.** Zitadel's access tokens carry no email, so the API calls userinfo with the caller's own token. It does this before taking any database lock, because holding a lock across a network call would block everyone else in the org if the provider is slow.
- **Only the token's hash is stored.** A database leak or a read-only SQL user cannot be turned into working invitation links. The token is shown once, to the admin who created it.
- **Accepting is a POST behind a button.** Link previews, email scanners, and prefetching all issue `GET`s, so a `GET` that consumed the invitation would be used up before the invitee ever saw it.
- **Every change takes the org lock.** Creating, revoking, and accepting all lock the organization row first (the same lock SENTRA-3 uses for membership changes). Caps are counted under that lock, so parallel requests cannot exceed them.
- **Expiry is checked when the token is used.** There is no cleanup job; an expired row is just a row that no longer matches. Expired invitations do not count against the pending cap.
- **Accepting twice is not an error.** The same user retrying gets the same organization back and no second audit event.

## Alternatives considered

- Token-only acceptance (bearer links): simplest, but a forwarded email would grant tenant access.
- Reading the email from the access token: not possible with Zitadel's default tokens.
- Storing the token (or encrypting it): a database leak would hand out working links.
- A signed token with a server secret: avoids a table lookup but adds a secret to rotate and cannot be revoked without a table anyway.
- Accept on `GET`: breaks with link scanners.
- A Redis rate limiter for invitations: new dependency; DB-enforced caps do the job for now.

## Tradeoffs made

- Cap defaults (50 pending, 50 per day, 100 members) are guesses. They bound abuse and storage but are not tuned.
- Accept depends on the identity provider being up. If userinfo is down the API answers `503` and nothing changes; the invitee retries.
- The accept link carries the token in the URL, so it can end up in browser history. It is single-use and bound to one verified email, which limits the damage.
- Distinct error codes (`mismatch`, `expired`, `unavailable`) help the invitee but tell a token holder something about the invitation. None of them includes the organization or the invited address.
- The profile is only read at accept time, so most users still have no stored name or email.

## Scaling implications

- Token lookup uses a unique index on the hash. The pending list is bounded by the pending cap, so it needs no pagination.
- Invitation and membership changes in one org are serialized by the org lock. Different orgs never wait on each other.
- Accept adds one outbound HTTP call (3 second timeout). It is rare, but if invitations became a hot path the call would need a cache or a stored profile.

## Important failure and security considerations

- **Races.** Parallel invitations stay under the pending cap. Two users racing for one token produce exactly one winner. One user accepting several times at once produces one membership and one audit event.
- **Deadlocks.** Accept first reads the invitation without a lock, then takes the org lock, then re-reads. Taking the invitation lock first would invert the order that create and revoke use.
- **Rollback.** If the audit insert fails, the membership and the invitation state roll back together, and the invitation stays usable.
- **Secrets.** Tokens and invited emails are not logged and are not in audit rows. A test scans captured logs for both.
- **Open redirects.** The "return to" cookie is only honored for paths that start with a single `/`.

## Key concepts to understand

- The difference between *possessing* a secret link and *being* the intended person.
- Why a lock must not be held across a network call.
- Lock ordering and how inverted orders cause deadlocks.
- Storing a hash of a secret you only need to compare.
- Why state-changing operations belong behind `POST`, not `GET`.
- Why an idempotent retry is better than an error for a double click.
