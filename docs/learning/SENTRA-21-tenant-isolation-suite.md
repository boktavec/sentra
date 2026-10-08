# SENTRA-21: Tenant isolation regression suite

## What was built

- `apps/api/src/tenant-isolation.integration.test.ts`: real Postgres, real routes, fake identity only. `task api:test:isolation` runs it, and `task test:integration` includes it.
- A table of cases (one per tenant-scoped route) run by three attackers: an outsider on the victim's URL, a user in both orgs using their own org's URL with the victim's IDs, and a plain member on admin-only routes.
- A coverage check: every `/v1` route must have a case or a reasoned exemption, or the suite fails.
- `it.todo` entries for findings, investigations and audit records, which don't exist yet.

## Why it is designed this way

- **Indistinguishable from "does not exist".** The cross-tenant response is compared with the response for a random ID. One oracle covers status, body and content type, so a 403 or a different message that reveals existence fails the test.
- **State, not just status.** After each attempt, every table with an `org_id` column (found through `information_schema`, so new tables are included automatically) is compared with its snapshot. A 404 that arrives after a write still fails.
- **The dual-member attacker.** A user in both orgs passes the membership check on their own org and then supplies the other org's IDs. This is the realistic IDOR bug, and an outsider-only test can't trigger it. The shared project slug in both orgs makes an import ID swap resolve to a real project.
- **Route coverage from the router.** An `onRoute` hook sees what is actually registered. Nobody has to remember to add a case, because the suite fails until someone does.

## Alternatives considered

- Mocked unit tests: fast, but they can't see SQL scoping, which is where the leak lives.
- A resource-level list instead of a route-level one: misses a new endpoint on an existing resource.
- Running in `task check` with an ephemeral database: stronger gate, but a new dependency and a slower fast path. SENTRA-25 (CI gate) is the place to run the suite per PR.

## Tradeoffs and scaling implications

- It needs the local stack, so it isn't part of the fast gate yet.
- Each new route costs one case entry. That friction is the point.
- Runtime is under a second, and rows are unique per run, so it scales with route count, not data.

## Failure and security considerations

- Mutation checks: removing the org and project scope from the SBOM import lookup fails 2 cases. Removing the org scope from the member lookup and update fails 1.
- Removing the scope from the member UPDATE alone passes, because a scoped SELECT runs first. That is defense in depth, and the suite correctly reports no leak.
- Not covered: object-storage keys, pipeline consumers, AI tools. Their stories add cases.

## Key concepts

- IDOR / confused deputy: authorizing the caller for the URL's org but not the resource's org.
- Oracle testing: compare the real response with a control instead of hard-coding expectations.
- Registry-based guards: make the safe path the only path that keeps CI green.
