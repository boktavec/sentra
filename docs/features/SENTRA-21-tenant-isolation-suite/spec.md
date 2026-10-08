# SENTRA-21: Automated tenant isolation regression coverage

- Status: Implemented
- YouTrack: http://localhost:8080/issue/SENTRA-21
- Owner: Sentra operator (admin)

## Problem and outcome

- Tenant isolation failures are high-severity. Per-feature tests cover the happy path and some denials, but nothing fails loudly when a *new* route or resource forgets to scope by tenant.
- Done means: one command exercises cross-tenant read and mutation attempts against real routes and Postgres, fails on any leak, and fails when a tenant-scoped route has no isolation case.

## Scope

- In scope:
  - A dedicated suite under `apps/api/src/` (`task api:test:isolation`, run from `task test:integration`) using the existing integration-test style: real Postgres, real routes, only identity faked (`x-test-user`).
  - Route-level coverage check: every registered route under `/v1/orgs/:orgId/...` must have an isolation case or an exemption with a reason.
  - Cases for existing resources: projects, SBOM uploads/imports, members, invitations. (`sbom:reprocess` is an operator CLI, not an HTTP route, so it is out of scope.)
  - `it.todo` entries for findings, investigations, audit records.
  - Acceptance criteria added to SENTRA-15, 16, 17, 20 requiring entries in this suite.
- Out of scope:
  - Object storage keys, pipeline/async consumers, AI tools (SENTRA-18), warehouse. Each later story registers its own cases.
  - Production code changes, unless the suite finds a real leak (then fix and note in the PR).
  - Running on every PR (depends on SENTRA-25 CI gate).
- Dependencies and related stories: SENTRA-3 (done). Feeds SENTRA-15, 16, 17, 18, 20. Related: SENTRA-25.

## Decisions and alternatives

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Timing vs unbuilt resources | Harness now, test existing resources, `it.todo` for the rest | Stub endpoints; wait for all stories | Real code under test and a P0 guard now. Story can't be fully closed on findings/investigations/audit until those land. |
| Where it runs | Dedicated `task api:test:isolation`, wired into `test:integration` | In fast `task check` with Testcontainers; mocked unit tests | Real SQL scoping is what leaks. Not in the fast gate, so it needs SENTRA-25 to run per PR. |
| Preventing skipped routes | Route-level coverage check via Fastify `onRoute` | Resource-level list; convention | Catches a new endpoint on an existing resource. Costs a maintained route-to-case table. |
| Cross-tenant contract | 404 identical to a nonexistent resource; body and headers carry nothing from the victim tenant | 403 for non-members; accept either | No existence leak, one rule. **Verified** in code: `orgs.ts` already throws 404 `tenant_access_denied` for non-members; `reason` appears only in logs. Suite pins it. |
| Mutation proof | Every mutating route, with a post-state SQL check | Destructive only; status only | Strongest. A create into the victim org must leave no new rows; updates/deletes leave rows unchanged. |
| Layers attacked | HTTP API plus the store scoping behind it | Add storage; add async | Matches where tenant input enters today. Gap recorded via registry. |
| Attackers | (a) non-member of victim org, (b) lower-role member of victim org on admin routes, (c) dual-member using home org in the URL with the victim's ID | Non-member only | Covers the confused-deputy ID-swap bug. Roughly 3 runs per route on shared fixtures. |
| Pending resources | `it.todo` plus criteria on SENTRA-15/16/17/20 | Todo only; keep story open | Gap is visible and enforced per story without holding a P0 open. |

## Architecture and contracts

- Components: `apps/api` only (test code and a small `onRoute` route-collection helper used by tests).
- Flow: build app, seed two orgs (admin and member each) plus a dual-member user and one victim resource per type through the API/SQL, run each attacker against each route, assert status/body, then re-read victim rows via SQL.
- Contracts: no API change. Pinned response: `404 {not_found}` identical to a random UUID or slug.
- Migration: none.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic | Test-only | n/a | n/a |
| Data size | Tens of rows per run, unique per-run slugs | Assumption | Parallel runs don't collide |
| Latency | Suite under 30s | Assumption, not a requirement | Measure first run, revisit if it slows `test:integration` |
| Availability | n/a | n/a | n/a |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| New `/v1/orgs/:orgId/...` route with no case or exemption | Suite fails naming the route | Test registers a throwaway route and expects the check to fail |
| Malformed or random IDs | Same 404 as cross-tenant | Compare bodies byte for byte |
| Cross-tenant mutation | 404 and victim rows unchanged | SQL read after each attempt |
| Dual-member with victim's child ID under home org | 404, no data | Attacker (c) |
| Lower-role member on admin route | 403 `role_denied` (existing contract) | Attacker (b) |
| Unauthenticated | 401, no tenant data | One case per route |
| Intended isolation leak (mutation test) | Suite goes red | Temporarily remove an org scope in a store and confirm failure (manual, in PR) |

## Security, observability, and rollout

- Isolation: the suite is the control. Fixtures are per-run so tests don't touch real data.
- Observability: assert a `tenant_access_denied` warn log and counter on non-member attempts (existing behavior), not new instrumentation.
- Rollout: test-only. Rollback is reverting the PR. Owner: whoever owns the API.

## Acceptance criteria

- [ ] Cross-tenant read and mutation attempts on projects fail with the pinned 404 and leave victim state unchanged.
- [ ] Same for SBOM uploads/imports (including reprocess), members and invitations.
- [ ] Findings, investigations and audit records exist as `it.todo` entries, with matching criteria added to SENTRA-15, 16, 17, 20.
- [ ] A registered tenant-scoped route with no case or exemption fails the suite.
- [ ] A deliberately introduced leak turns `task test:integration` red (shown in PR).
- [ ] Documented in `docs/security/security.md` and a learning note.

## Verification

- Manual (done): break an org scope in one store, run `task api:test:isolation`, expect failure; revert.
- Automated: the suite itself, plus a test of the coverage check.

- Mutation checks run: removing the org and project scope from the SBOM import lookup fails 2 cases; removing the org scope from the member lookup and update fails 1. Removing only the UPDATE scope passes, because the scoped SELECT before it already 404s (defense in depth, not a leak).
- Local note: `infra/docker/.env.sentra` from an older `stack:bootstrap` lacks `S3_*`; re-run `task stack:bootstrap`.

## Open questions and assumptions to validate

- Suite runtime: measured under 1s for 47 tests (the 30s target was a guess).
- Exemptions decided: `GET /v1/me`, `POST /v1/orgs`, `GET /v1/orgs` (checked separately), `POST /v1/invitations/accept`.
- Run it on every PR once SENTRA-25 lands.
