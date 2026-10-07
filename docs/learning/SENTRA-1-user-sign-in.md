# SENTRA-1: User sign-in

## What was built

- **Zitadel** (self-hosted OIDC provider) in the local Docker stack, configured as code by `task stack:bootstrap`.
- **`apps/web`**: Next.js is the OIDC client (authorization code + PKCE). Tokens live in Redis; the browser holds only an opaque session ID in an httpOnly cookie. Sign-out ends both the Sentra session and the Zitadel session.
- **`apps/api`**: the only component that verifies user tokens. It checks the JWT locally against cached signing keys, provisions a Sentra user row on first sight, and throttles repeated auth failures per IP.
- **`packages/ts-platform`**: shared logger (structured JSON, secrets redacted) and error handling (one place that turns errors into RFC 9457 responses). The contracts for both are language-neutral docs in `packages/contracts`.

## Why it is designed this way

- **Don't build auth.** Passwords, MFA, email verification, lockout and registration are solved problems with sharp edges. We configure a standard provider and only write the verification of what it issues.
- **One verifier.** If every service validated tokens itself, a fix or a policy change would need to land in several languages. The API verifies once and passes a verified identity (`userId`, `correlationId`) onward.
- **Local verification, not introspection.** Checking a signature against cached public keys needs no network call per request, so it scales with the API replicas and survives a provider outage. The cost is that revocation is bounded by the 10-minute token lifetime.
- **Sessions in Redis, not in the cookie.** An encrypted cookie session can't be invalidated by the server. With Redis, sign-out and a rejected refresh token really end the session, and web instances stay stateless.
- **Count only failures for rate limiting.** Valid requests never touch Redis and never get throttled, which also avoids punishing users behind a shared NAT. An attacker still gets `429` after the limit.

## Alternatives considered

- Hosted provider (Clerk/Auth0), Keycloak, Ory, Auth.js: see ADR 0001.
- API gateway verifying tokens: no scaling benefit (verification is cheap CPU), an extra hop and failure point.
- Opaque tokens with introspection: instant revocation but a provider call on every request.
- Encrypted-cookie sessions: fewer moving parts, but no server-side revocation.
- In-memory or Postgres rate-limit counters: wrong across replicas, or attacker-controlled write load on the main database.

## Tradeoffs made

- Revocation lag of up to one access-token lifetime (10 min, an assumption to tune).
- Web sign-in depends on Redis and fails closed; the API's rate limiter depends on Redis and fails open. The difference is deliberate: a limiter outage should not lock everyone out, but we can't create a session without somewhere to store it.
- Open registration with verified email. Cheap to use, but it allows signup spam; there is no control for that yet.
- Audience is validated against an allow-list of client IDs because Zitadel did not add the project ID to `aud` for this app.
- Email/name are not populated yet, because Zitadel access tokens don't carry them.

## Scaling implications

- The API is stateless: add replicas freely. Per-request cost is a local signature check, plus a cache lookup for the user.
- The first request from a user does one database upsert; later requests hit an in-process cache (cleared at 10,000 entries).
- Redis holds sessions and failure counters. Both are small, TTL-bound keys.
- Zitadel is the shared dependency for sign-in, token refresh and registration, but **not** for already-authenticated API traffic. This was verified by stopping it while the API kept serving.

## Failure and security considerations

- **Safe errors.** Every auth failure returns the same generic body. The real reason (`expired`, `invalid_signature`, ...) goes to logs and counters only.
- **Key handling.** Unknown key IDs trigger at most one refresh per minute, so an attacker can't turn random `kid`s into a fetch storm. A failed refresh keeps serving the old keys. If keys were never loaded, the API reports not ready and answers `503`.
- **Algorithm pinning.** Only RS256 is accepted, so `alg: none` and algorithm-confusion tokens are rejected.
- **Spoofed client IPs.** `X-Forwarded-For` is ignored unless trusted proxies are explicitly configured; otherwise the limit would be trivially evaded.
- **Logout CSRF.** The logout endpoint checks the `Origin` header.
- **Refresh races.** A short Redis lock stops parallel requests from using a rotating refresh token twice.
- **Registration alone must not sign a user in.** Zitadel's login UI doesn't require email verification by default; the login container needs `EMAIL_VERIFICATION=true`. The E2E test asserts no Sentra session exists before verification.

## Key concepts to understand

- **OIDC authorization code + PKCE**: the browser never sees tokens, and a stolen authorization code is useless without the verifier.
- **JWT access tokens and JWKS**: tokens are signed; verification needs only the issuer's public keys, which can be cached and rotated.
- **`iss` / `aud` / `exp` validation**: which issuer, which intended recipient, how long.
- **Access vs refresh vs ID tokens**, and why refresh tokens stay server-side.
- **Fail open vs fail closed**: choose per dependency, based on what an outage should cost.
- **Idempotent provisioning**: `INSERT ... ON CONFLICT` makes first-request races safe.
- **Authentication vs authorization**: SENTRA-1 answers "who is this?". "What may they do?" arrives with organizations and roles in SENTRA-2/3.

## How to run it

```bash
task stack:up          # Zitadel, Redis, Postgres, Mailpit
task stack:bootstrap   # one-off Zitadel setup; writes infra/docker/.env.sentra (gitignored)
task api:dev           # API on :4000
task web:dev           # web on :3000; register, then read the code in Mailpit at :8025
task test:integration  # API integration tests + Playwright E2E against the live stack
```
