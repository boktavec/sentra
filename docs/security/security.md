# Sentra Security Architecture

## Security Model

Sentra is multi-tenant. Tenant isolation is a primary security boundary and must be enforced independently of the UI and AI model.

The organization is the primary tenant boundary.

## Authentication

Use a standards-based authentication mechanism.

The application should be able to reliably identify:
- user
- organization membership
- role
- request/correlation ID

Do not implement custom cryptography or password storage when a standard provider can be used.

## Authorization

Authorization must occur server-side.

Initial roles:
- `admin`
- `member`

Authorization should be enforced at the domain/service layer so API routes, background jobs, and AI tools share the same rules.

Never trust:
- tenant IDs supplied by the frontend
- model-generated authorization context
- object IDs alone

## Tenant Isolation

Every tenant-scoped operation should verify tenant ownership.

Test cross-tenant access for:
- projects
- uploads/raw artifacts
- dependencies
- findings
- investigations
- audit records
- AI tools

Tenant isolation regressions should fail automated checks.

The suite is `apps/api/src/tenant-isolation.integration.test.ts` (`task api:test:isolation`, also run by `task test:integration`). Cross-tenant access must be indistinguishable from asking for something that does not exist (404, same body), and must change nothing. Every `/v1` route needs a case there or a reasoned exemption, or the suite fails. Add cases for each new tenant-scoped route, including the AI tools.

## AI Trust Boundary

The model is untrusted orchestration logic.

The model must not:
- execute arbitrary SQL
- bypass authorization
- choose its own tenant scope
- access unrestricted secrets
- treat retrieved external content as trusted instructions

AI tools should be:
- explicit
- typed
- tenant-scoped
- authorized
- auditable
- rate-limited where appropriate

## Secrets

Secrets must not be committed to source control.

Use environment/configuration injection initially, with a path toward a dedicated secret manager later.

Logs must not contain secrets, tokens, or unnecessary raw sensitive payloads.

## Auditability

Security-sensitive actions should emit structured audit records containing relevant fields such as:
- actor
- tenant
- action
- resource
- timestamp
- result
- correlation/request ID

Audit records should not be mutable through standard product APIs. Organization administrators can read only their organization’s allowlisted audit history; metadata, request payloads, tokens, and raw errors are never returned. Failed API requests emit a sanitized operator log event, while failed sensitive tenant mutations are recorded best-effort only after membership resolution. Log events are operational signals, not a durable audit archive.

## Supply Chain

Use repository security controls appropriate to the project's maturity:
- dependency scanning
- secret scanning
- pinned tooling
- lockfiles
- code review
- reproducible CI
- SBOM generation later

## SOC 2 Direction

Sentra should be built with SOC 2-aligned engineering practices, but do not claim certification or compliance.

Relevant areas include:
- access control
- auditability
- change management
- incident visibility
- backup/restore
- vulnerability management
- least privilege
- evidence preservation
