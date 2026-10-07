# SENTRA-1: User Sign-In

- Status: Draft
- YouTrack: SENTRA-1 (Identity & Tenant Foundation, P0, size M)
- Owner: Brian Oktavec
- ADR: [0001 Identity provider and token verification](../../adr/0001-identity-provider-and-token-verification.md)

## Problem and outcome

- **Who/why:** Every tenant-scoped operation in Sentra starts from a verified identity. Before organizations, projects, findings, or AI investigations exist, the platform needs a clear identity boundary built on a standard mechanism, not custom password or session logic.
- **Done means:** A user can register, verify their email, sign in (optionally with TOTP MFA), and sign out through the web app. The API identifies the user on every protected request and rejects everything else with a safe error. Auth outcomes are visible in logs and metrics. Logging and error handling are implemented as shared modules that later stories reuse.

## Scope

- In scope:
  - Zitadel (self-hosted, Docker) as the OIDC identity provider; configuration committed as code, no secrets in the repo.
  - Self-service registration with email verification; email + password sign-in; optional TOTP MFA.
  - Next.js as a server-side OIDC client (authorization code + PKCE), httpOnly session cookie, server-side token refresh, route protection, sign-out via RP-initiated logout.
  - API JWT verification (JWKS cached), authenticated-user request context, just-in-time `users` row.
  - Failed-auth rate limiting per IP, backed by Redis.
  - Shared logging and error-handling modules (see below).
  - Auth outcome logs and counters.
- Out of scope (future work):
  - API gateway or reverse proxy for token verification.
  - Per-user rate limits and signup-spam controls.
  - Social login and enterprise SSO; enforced MFA.
  - Instant token revocation or introspection.
  - Organizations, memberships, roles, tenant IDs (SENTRA-2/3).
  - Full OpenTelemetry traces/metrics pipeline and log aggregation (SENTRA-22/23).
  - Service-to-service authentication for Python services.
- Dependencies and related stories:
  - Blocks SENTRA-2, 3, 4.
  - Adds Zitadel (+ its Postgres), Redis, and a mail sink (Mailpit) to the local stack, which SENTRA-24 must adopt or incorporate.
  - SENTRA-22 will standardize and extend the logging module introduced here rather than replace it.

## Decisions and alternatives

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Identity provider | Self-hosted Zitadel in Docker | Hosted (Clerk/Auth0); Keycloak; Ory; Auth.js in Next.js | Local-first, no vendor dependency, lighter than Keycloak, less assembly than Ory. Cost: another service to run; smaller community. |
| Tenancy source of truth | Zitadel is identity only; Sentra orgs and roles live in Sentra's Postgres | Use Zitadel organizations | One source of truth for tenancy and authorization; avoids coupling the tenant model to the IdP. |
| Session model | Next.js server-side OIDC client (code + PKCE), tokens held server-side, httpOnly cookie; Bearer access token to API | Browser-side OIDC; opaque tokens with introspection | Tokens never reach browser JS; API stays stateless. Cost: Next.js owns refresh. |
| Token verification | API verifies JWT locally against cached JWKS; sole verifier | Per-service verification; gateway; introspection | One place for auth logic (AC 6), no per-request network call, scales with API replicas. Gateway is a revisit trigger (second user-facing service, centralized WAF/rate limiting). |
| User record | JIT upsert on first authenticated request, keyed by `(issuer, sub)`, internal UUID PK | No user table; webhook sync | Decouples Sentra IDs from IdP IDs with no extra infrastructure. Cost: cached email/name can go stale until next sign-in. |
| Sign-in methods | Email + password, optional TOTP MFA, self-registration with email verification | Social login; enforced MFA; invite-only | Smallest setup that works offline; MFA available without test friction. Cost: accounts without MFA are weaker; open signup can be abused. |
| Token lifetime | Access token 10 min; refresh server-side; idle session ~8–12 h | 1–2 min tokens; per-action revocation checks | Bounded revocation lag; sessions survive brief Zitadel outages. Cost: not instant revocation. |
| JWKS handling | Cache; refresh on unknown `kid` (throttled, ~1/min); serve stale on refresh failure; not-ready at cold start if never fetched | Fail closed; fetch per request | Zitadel outage does not sign out active users; random `kid`s cannot force fetch storms. Cost: a revoked key can verify until the next successful refresh. |
| Abuse limits | Zitadel lockout for password guessing plus API per-IP failed-auth limit in Redis, fail open | In-memory per instance; Postgres counters; edge limiting | Holds across replicas. Cost: new Redis dependency; shared-NAT users may be affected. |
| Observability | API-side auth logs and counters; sign-in internals stay in Zitadel's event log | Logs only; full OTel now | Meets AC 5 cheaply; SENTRA-22/23 extend it. |
| Testing | Integration tests against real Zitadel + Redis, one Playwright E2E, unit tests for pure logic | Mock OIDC server; mocks only | Proves the riskiest part (the real integration). Cost: slower tests, heavier CI. |
| Shared logging and error handling | New TS workspace package `packages/ts-platform` (logger, error types, error-to-response mapping); cross-language contract documented in `packages/contracts` | Modules inside `apps/api` only; per-feature ad hoc handling | Used by `apps/api` and `apps/web` server code without duplication, and the contract lets Python services implement the same shape. Python services get their own implementation per the "no shared implementation across languages" rule. Cost: one new package. |

## Architecture and contracts

- **Affected components:**
  - `apps/web`: sign-in/out UX, OIDC client, session cookie, route protection (UX only).
  - `apps/api`: auth middleware, JWKS cache, rate limiter, user provisioning.
  - `packages/ts-platform` (new): logger, errors.
  - `packages/contracts`: error body and log field contract; identity shape for downstream services.
  - Local stack: minimal compose file for Zitadel, Redis, Mailpit (`infra/docker`), started via Task.
- **Request flow:**
  1. Browser requests a protected page, so Next.js redirects to Zitadel (code + PKCE).
  2. After sign-in, Next.js exchanges the code, stores tokens server-side, and sets an httpOnly session cookie.
  3. Next.js server code calls the API with `Authorization: Bearer <access token>`.
  4. The API checks the per-IP failure limit, then verifies the token: signature, `iss`, `aud`, `exp`, `nbf`, expected algorithm only, ~30 s skew.
  5. The API upserts the user on first sight and attaches `{ userId, issuer, subject }` plus the correlation ID to the request context.
  6. The route handler runs; failures are thrown as typed errors and mapped to responses in one place.
- **Error contract:**
  - `401` for missing/invalid/expired tokens, with a generic RFC 9457 `application/problem+json` body (e.g. "Authentication required"). The specific reason goes to logs and metrics only.
  - `429` with `Retry-After` when rate-limited.
  - Unexpected errors map to a generic `500` with a correlation ID. No stack traces or internals in responses.
  - `403` semantics belong to SENTRA-3.
- **Logging contract:**
  - Structured JSON: `timestamp`, `level`, `service`, `message`, `correlationId`, plus `userId` where known.
  - Redaction by default for `authorization`, cookies, tokens, passwords.
  - Request-scoped child logger carrying the correlation ID. The ID is accepted from `X-Correlation-Id` or generated, and echoed on responses.
  - Tenant ID is added once it exists (SENTRA-2).
- **Identity passed downstream:** `userId` and `correlationId` in the HTTP/event contract. Python services never see user tokens.
- **Storage:** `users(id uuid pk, issuer text, subject text, email text, name text, created_at, updated_at, unique(issuer, subject))`. The upsert is idempotent and safe under concurrent first requests (`INSERT ... ON CONFLICT`).
- **Compatibility:** greenfield, nothing to migrate.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | Under ~10 req/s on the API | Assumption: MVP, tens of users | SENTRA-26/27 baselines |
| Concurrent users or jobs | Tens | Assumption | SENTRA-27 k6 workload |
| Data size and growth | One small row per user | Derived | n/a |
| Latency or throughput target | **Unknown.** Token verification is local CPU and should be negligible against request latency | No target invented | Measure in SENTRA-26/27 |
| Availability and recovery target | **Unknown.** Active sessions keep working during a Zitadel outage; sign-in/refresh/registration do not | Design property, not an SLO | Failure test below |
| Failed-auth limit | 10 failures/IP/minute, then `429` | Assumption, tunable by config | Tune from auth-failure counters |
| Access token lifetime | 10 min; idle session ~8–12 h | Assumption | Confirm in Zitadel config test |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Missing, malformed, or non-Bearer `Authorization` | `401` generic problem body; reason logged and counted | API integration test |
| Expired token, wrong `iss`/`aud`, tampered signature, `alg: none`, wrong algorithm | `401`, same generic body for all | API integration tests (one per case) |
| Token with unknown `kid` | One throttled JWKS refresh; `401` if still unknown | Integration test with rotated key |
| Zitadel/JWKS unreachable after warm cache | Keep verifying from cached keys; log warning | Integration test stopping Zitadel |
| JWKS never fetched (cold start, Zitadel down) | Readiness reports not ready; protected requests return `401`/`503` without crashing | Integration test |
| Redis unavailable | Rate limiter fails open; error logged and counted; auth still works | Integration test stopping Redis |
| Over the failure limit | `429` with `Retry-After`; resets after the window | Integration test |
| Concurrent first requests from a new user | Exactly one `users` row | Concurrency test against Postgres |
| Spoofed `X-Forwarded-For` | Ignored unless trusted-proxy config is set | Unit/integration test |
| Unverified email | Cannot sign in | Playwright E2E with Mailpit |
| MFA enrolled user | TOTP challenge required | Manual check (optional MFA, not in CI) |
| Sign-out | Session cookie cleared; Zitadel session ended; refresh fails afterward | Playwright E2E |
| Unauthenticated page request | Redirect to sign-in (UX); API remains the enforcement point | Playwright E2E + API test |
| Tenant boundary and unauthorized access | No tenant data exists yet; this story provides identity only. Error bodies never reveal why a token was rejected | Covered by error-contract tests |

## Security, observability, and rollout

- **Authorization, sensitive data, abuse limits:**
  - No custom password or session crypto. The API only verifies standard JWTs.
  - Tokens are never logged or exposed to browser JS.
  - Secrets come from environment/config, not the repo.
  - Zitadel lockout plus the per-IP failed-auth limit.
- **Logs, metrics, traces, alerts:**
  - The API logs every auth outcome with a coarse reason (`missing_token`, `expired`, `invalid_signature`, `unknown_issuer`, `rate_limited`, `success`).
  - Counters per outcome; Redis fail-open and JWKS refresh failures are counted.
  - No alerts in this story (SENTRA-23).
- **Rollout, migration, rollback, owner:**
  - Greenfield. The one migration creates `users`; rollback is dropping it.
  - Zitadel is bootstrapped by a committed seed or config script.
  - Operational owner: Brian Oktavec.

## Acceptance criteria

- [ ] A user can register, verify their email, and sign in through Zitadel (optionally with TOTP MFA).
- [ ] Unauthenticated users are redirected from protected web routes, and API requests without a valid token get `401`.
- [ ] The API resolves the authenticated user (internal UUID) on every protected request, creating the `users` row on first sight, idempotently under concurrency.
- [ ] Auth failures return a generic RFC 9457 body that does not reveal the failure reason, token contents, or internals.
- [ ] Auth outcomes are logged (structured, tokens redacted) and counted.
- [ ] Token verification exists only in the API; no other service or app re-implements it.
- [ ] More than 10 failed auths per IP per minute returns `429`; the limiter fails open if Redis is down.
- [ ] A Zitadel outage does not invalidate sessions that are already signed in.
- [ ] Sign-out ends the web session and the Zitadel session.
- [ ] Logging and error handling live in a shared package and are used by the API's auth path and the web server code, with no per-feature copies.

## Verification

- **Manual checks and expected results:**
  - Bring up the local stack, register a user, read the verification email in Mailpit, and sign in, which lands on a protected page.
  - Enroll TOTP in Zitadel, sign out, and sign in again, which presents a TOTP challenge.
  - Call the API with no token, an expired token and a tampered token, and expect identical generic `401` bodies.
  - Stop Zitadel and confirm an already signed-in session still works while new sign-ins fail.
  - Trigger 11 bad-token requests and expect `429`.
- **Automated tests and what they prove:**
  - API integration tests (real Zitadel, Redis, Postgres) prove token verification, rate limiting, JIT provisioning, JWKS behavior and failure modes.
  - One Playwright E2E proves the full browser flow (register, verify, sign in, protected route, sign out).
  - Unit tests for error mapping, log redaction, claim-to-user mapping and IP resolution.
  - Tests for the shared package prove that error and log shapes match the contract.
- **Load or failure tests:** none beyond the failure tests above. Performance baselines belong to SENTRA-26/27.

## Open questions and assumptions to validate

- **Library choices.** Logger (leaning `pino`, for built-in redaction), JWT/JWKS verification (leaning `jose`), OIDC client for Next.js, and Redis client need confirming via context7 against current versions before implementation. Each is a new dependency and will be justified in the PR. Owner: Brian, before implementation.
- **Shared package placement.** Resolved at spec review: `packages/ts-platform` is the home for shared logging and error handling.
- **10-minute access token and 8–12 hour idle session.** Assumptions. Validate against Zitadel defaults and adjust.
- **Signup spam.** Open registration is accepted for the MVP. Add a trigger (e.g. signup volume) for introducing a control.
- **Trusted-proxy configuration.** How `X-Forwarded-For` trust is configured in deployment is deferred until there is a deployment topology.
- **SENTRA-24 alignment.** Resolved at spec review: SENTRA-1 ships a minimal compose file (Zitadel + its Postgres, Redis, Mailpit) exposed through Task commands. SENTRA-24 later adopts and extends it.
