# 0001: Identity provider and token verification

- Status: Proposed
- Date: 2026-10-07
- Related: [SENTRA-1 spec](../features/SENTRA-1-user-sign-in/spec.md)

## Context

Sentra needs a standard authentication mechanism before any tenant-scoped feature exists. Requirements: no custom password or session logic, local-first development in Docker, auth logic not duplicated across services, and a stateless API that scales horizontally.

## Decision

- Run **Zitadel** (self-hosted) as the OIDC identity provider. It is the source of truth for identity only. Organizations, memberships, and roles live in Sentra's Postgres.
- **Next.js** is a server-side OIDC client (authorization code + PKCE) and keeps tokens server-side behind an httpOnly cookie.
- **`apps/api` is the only component that verifies user tokens**, locally against cached JWKS. Python services receive verified identity (`userId`, `correlationId`) through explicit contracts and never see user tokens.
- Users are provisioned just-in-time, keyed by `(issuer, subject)` with a Sentra-owned UUID primary key.

## Alternatives considered

- Hosted providers (Clerk, Auth0): fastest to ship, but vendor dependency and cost, and not local-first.
- Keycloak: widely documented, but heavy for a local stack.
- Ory (Kratos + Hydra): modular, but several services to assemble and a login UI to build.
- Auth.js inside Next.js: no extra service, but the API would have to verify web-issued sessions, which makes single-point verification harder.
- API gateway verifying tokens: no scalability benefit for local JWT verification, and it adds a hop, a failure point, and infrastructure we don't need yet.
- Per-service verification libraries: duplicates auth logic across languages.
- Opaque tokens with introspection: instant revocation, but a network call to Zitadel on every request.

## Consequences

- One verification point keeps auth logic in one place and scales with the API.
- Revocation is bounded by access-token lifetime (assumed 10 minutes), not instant.
- Active sessions survive a Zitadel outage. New sign-ins, refresh, and registration do not.
- The local stack gains Zitadel (plus Postgres), Redis, and a mail sink.
- Python services must be protected by network isolation or a service credential. This is defined in a later story.
- **Revisit triggers:** a second user-facing service, a need for centralized rate limiting or WAF, a requirement for instant revocation, or enterprise SSO.
