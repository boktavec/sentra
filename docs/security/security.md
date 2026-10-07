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

Audit records should not be mutable through standard product APIs.

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
