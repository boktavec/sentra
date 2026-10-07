# Sentra MVP User Stories

## MVP Goal

Build a production-minded, multi-tenant security intelligence platform that can:

1. Allow users to create and access an organization and project.
2. Accept an SBOM or dependency inventory from a tenant.
3. Ingest vulnerability intelligence from an initial set of external sources.
4. Preserve raw source data and normalize it into a common internal model.
5. Correlate tenant dependencies with known vulnerabilities.
6. Present findings and risk context through a SaaS interface.
7. Allow users to run an AI-assisted investigation against their findings.
8. Enforce tenant isolation and maintain an audit trail.
9. Provide enough observability and testability to operate the MVP confidently.
10. Establish the foundation for later warehouse, prediction, and large-scale load testing work.

The MVP should remain intentionally small. Do not add advanced infrastructure, microservices, sharding, Kubernetes, billing, or predictive ML until the MVP requires them.

---

# Epic 1 — Identity and Tenant Foundation

## SENTRA-1 — User Sign-In

### User Story

As a user, I want to securely sign in to Sentra so that I can access the organizations and security data I am authorized to view.

### Context

Authentication is the entry point to every tenant-scoped operation in Sentra. The MVP needs a clear identity boundary before tenant data, projects, findings, or AI investigations are exposed.

The implementation should use a standard authentication mechanism rather than custom password or session logic.

### Acceptance Criteria

- A user can sign in using the selected authentication provider.
- An unauthenticated user cannot access authenticated application routes or APIs.
- The backend can identify the authenticated user for each protected request.
- Authentication failures return safe, non-sensitive errors.
- Authentication-related actions are observable through appropriate logs or metrics.
- Authentication logic is not duplicated independently across services.

---

## SENTRA-2 — Create Organization

### User Story

As an authenticated user, I want to create an organization so that I can establish an isolated workspace for my security data.

### Context

The organization is the primary tenant boundary for the MVP. All projects, uploaded assets, findings, investigations, and audit records must belong to an organization.

This feature establishes the tenant model that future authorization and scaling work will depend on.

### Acceptance Criteria

- An authenticated user can create an organization.
- The organization has a unique identifier independent of its display name.
- The creating user becomes an organization administrator.
- Organization ownership is persisted in the operational database.
- Users cannot access organizations they are not authorized to access.
- Organization creation generates an audit event.
- Tenant identifiers are propagated through relevant backend operations.
- A signed-in user can create an organization from the web app, see their organizations, and open one by its slug; an organization they do not belong to looks the same as one that does not exist.

---

## SENTRA-3 — Organization Membership and Roles

### User Story

As an organization administrator, I want members to have explicit roles so that access can be controlled consistently.

### Context

The MVP does not need a complex policy engine, but it does need a clear authorization model. Start with a small number of roles that can evolve later.

### Acceptance Criteria

- The system supports at least `admin` and `member` organization roles.
- Authorization is enforced server-side.
- A member cannot perform administrator-only operations.
- Role checks use the authenticated user's organization membership.
- Attempts to bypass tenant or role boundaries are rejected.
- Authorization failures do not reveal sensitive information from other tenants.

---

# Epic 2 — Project and Asset Management

## SENTRA-4 — Create Security Project

### User Story

As an organization member, I want to create a project so that I can group a specific application's dependencies and findings.

### Context

Projects provide a useful product boundary underneath the organization. A project may later represent a repository, application, service, or environment.

### Acceptance Criteria

- An authorized user can create a project within an organization.
- A project contains a name, unique identifier, organization identifier, and timestamps.
- Project names do not need to be globally unique.
- Users can list projects for organizations they belong to.
- Users cannot read or modify projects in other organizations.
- Project creation generates an audit event.

---

## SENTRA-5 — Upload SBOM

### User Story

As a project member, I want to upload an SBOM so that Sentra can understand the software dependencies used by my application.

### Context

The SBOM is the first tenant-provided source of software inventory for the MVP. The system should preserve the original file and process it asynchronously rather than performing expensive parsing within the HTTP request.

Start with one documented SBOM format and expand later.

### Acceptance Criteria

- A user can upload a supported SBOM file to a project.
- Upload size and file type are validated.
- The raw uploaded artifact is preserved in object storage.
- The upload is associated with the correct organization and project.
- Processing occurs asynchronously after the upload is accepted.
- The user receives a stable identifier for the uploaded SBOM/import.
- Invalid files fail safely with an understandable status.
- A tenant cannot reference or retrieve another tenant's uploaded artifact.
- Upload and processing state changes are observable.
- An audit event is recorded for the upload.

---

## SENTRA-6 — Parse SBOM Dependencies

### User Story

As a project member, I want Sentra to extract dependencies from my SBOM so that they can be correlated with vulnerability intelligence.

### Context

Parsing should convert source-specific SBOM content into Sentra's normalized dependency model. The parser should be replayable against the preserved raw artifact.

### Acceptance Criteria

- A valid supported SBOM is parsed into normalized dependency records.
- Each normalized dependency includes sufficient identity information to match against vulnerability sources.
- Duplicate dependencies within the same import are handled deterministically.
- Parsing is idempotent when the same processing event is retried.
- Parsing failures preserve the original upload and expose a failed processing state.
- The system records enough metadata to identify the source import that produced each dependency.
- Reprocessing the raw SBOM does not require re-uploading it.

---

# Epic 3 — External Security Data Ingestion

## SENTRA-7 — Ingest OSV Vulnerability Data

### User Story

As a Sentra operator, I want Sentra to ingest vulnerability data from OSV so that tenant dependencies can be matched against known vulnerabilities.

### Context

OSV is one of the initial authoritative vulnerability sources for the MVP. Ingestion should preserve source data before transformation so the pipeline can be replayed later.

### Acceptance Criteria

- Sentra can fetch vulnerability data from OSV.
- Raw source payloads are stored before normalization.
- Each ingestion run has a stable job/run identifier.
- The crawler respects source rate limits and timeouts.
- Temporary failures use bounded retries with backoff.
- Repeated ingestion does not create uncontrolled duplicate normalized records.
- Failed ingestion attempts are observable.
- Successful ingestion emits or triggers downstream processing without tightly coupling fetching to normalization.

---

## SENTRA-8 — Ingest CISA KEV Data

### User Story

As a Sentra operator, I want Sentra to ingest the CISA Known Exploited Vulnerabilities catalog so that actively exploited vulnerabilities can be identified.

### Context

CISA KEV adds exploitation context that improves prioritization beyond severity alone.

### Acceptance Criteria

- Sentra can retrieve the current CISA KEV catalog.
- Raw source data is preserved.
- Records are normalized into the internal vulnerability model or linked enrichment model.
- Re-running ingestion is idempotent.
- A vulnerability can be identified as present or absent in KEV.
- Source timestamps and provenance are preserved.
- Failures and retries are observable.

---

## SENTRA-9 — Ingest GitHub Security Advisory Data

### User Story

As a Sentra operator, I want Sentra to ingest GitHub Security Advisory data so that dependency findings can include additional ecosystem vulnerability coverage.

### Context

This is the third initial source for the MVP and helps validate that the crawler/pipeline design can support multiple providers without creating provider-specific logic throughout the application.

### Acceptance Criteria

- Sentra can retrieve GitHub Security Advisory data using the selected API.
- Authentication or API credentials are handled through secure configuration.
- Source rate limits are respected.
- Raw responses are preserved.
- Advisory records are normalized through a provider-specific adapter into the common domain model.
- Duplicate or overlapping advisories are handled deterministically.
- Source provenance remains available after normalization.
- Errors and rate-limit conditions are observable.

---

## SENTRA-10 — Schedule and Track Ingestion Jobs

### User Story

As a Sentra operator, I want ingestion jobs to be scheduled and tracked so that security data stays current without manual intervention.

### Context

The MVP needs a simple recurring ingestion mechanism and job-state model. It does not need a sophisticated orchestration platform yet.

### Acceptance Criteria

- Each supported external source can be triggered on a configured schedule.
- A job records source, start time, completion time, status, and failure information.
- Concurrent runs for the same source are controlled intentionally.
- A failed job can be retried without corrupting normalized data.
- Job status can be inspected operationally.
- Scheduling can be disabled for development or testing.
- The design allows a future orchestration system to replace the MVP scheduler without rewriting source adapters.

---

# Epic 4 — Normalization and Data Pipeline

## SENTRA-11 — Normalize Vulnerability Records

### User Story

As the Sentra platform, I want external vulnerability records converted into a common model so that the rest of the system does not depend on provider-specific schemas.

### Context

Each external source represents vulnerabilities differently. A canonical internal model is required for correlation, UI, APIs, and AI tools.

### Acceptance Criteria

- OSV, CISA KEV, and GitHub data map into documented internal models.
- Source-specific adapters remain separate from domain logic.
- Original source identifiers and provenance are preserved.
- Reprocessing the same raw artifact is idempotent.
- Schema validation occurs before invalid normalized records are persisted.
- Normalization failures can be traced back to the source artifact.
- Versioning or evolution of normalized records is considered in the implementation.

---

## SENTRA-12 — Deduplicate and Correlate Vulnerability Sources

### User Story

As a user, I want overlapping vulnerability intelligence consolidated so that I do not see redundant findings for the same underlying issue.

### Context

Multiple providers may describe the same CVE or package vulnerability. The system should retain source provenance while presenting a useful consolidated representation.

### Acceptance Criteria

- Clearly identical vulnerability records can be linked or consolidated.
- Source provenance is never discarded.
- Deduplication is deterministic and repeatable.
- Ambiguous records are not incorrectly merged solely to reduce duplicates.
- New source data can enrich an existing vulnerability record.
- The chosen matching strategy and known limitations are documented.

---

# Epic 5 — Vulnerability Correlation and Findings

## SENTRA-13 — Match Dependencies to Vulnerabilities

### User Story

As a project member, I want Sentra to match my normalized dependencies against known vulnerabilities so that I can identify affected software.

### Context

This is the central product capability of the MVP. Matching must be explainable and should avoid hiding uncertainty.

### Acceptance Criteria

- Normalized project dependencies can be correlated with normalized vulnerabilities.
- Package ecosystem, name, and version information are considered.
- Matches produce tenant- and project-scoped finding records.
- Re-running correlation is idempotent.
- Findings retain references to the dependency and source vulnerability evidence.
- Unsupported or ambiguous version data is handled explicitly rather than guessed.
- A tenant cannot access findings generated for another tenant.

---

## SENTRA-14 — Calculate MVP Risk Priority

### User Story

As a project member, I want findings prioritized using transparent risk signals so that I can focus on the most important vulnerabilities first.

### Context

The MVP should use a deterministic, explainable prioritization model rather than predictive ML. Initial signals may include severity, known exploitation, and tenant exposure.

### Acceptance Criteria

- Each finding receives a deterministic priority or risk score.
- The factors contributing to the score are available for explanation.
- CISA KEV presence influences prioritization.
- Missing enrichment data does not cause unpredictable results.
- Score calculation is covered by unit tests.
- The scoring model is documented and can evolve later without changing the finding identity.

---

## SENTRA-15 — Findings List

### User Story

As a project member, I want to view my project's vulnerability findings so that I can understand its current security exposure.

### Context

The first UI should focus on useful security information rather than advanced dashboards.

### Acceptance Criteria

- A user can view findings for an authorized project.
- Findings display at least vulnerability identifier, affected dependency, severity/risk, exploitation context where available, and status.
- Findings can be sorted or filtered by at least risk/severity.
- Empty, loading, and error states are handled.
- Tenant and project boundaries are enforced server-side.
- The page performs acceptably for the expected MVP dataset.
- UI implementation is manually verified with Playwright and documented with PR screenshots.

---

## SENTRA-16 — Finding Detail

### User Story

As a project member, I want to inspect a finding in detail so that I can understand why Sentra considers my application affected.

### Context

Findings need evidence and provenance. Users should be able to distinguish source facts from Sentra-derived prioritization.

### Acceptance Criteria

- A user can open a finding from the findings list.
- The page displays affected package/version information.
- The page shows the associated vulnerability/advisory information.
- Source provenance is visible.
- Risk factors or prioritization rationale are visible.
- CISA KEV status is visible when applicable.
- Unauthorized users cannot retrieve another tenant's finding by manipulating an identifier.
- UI implementation is manually verified with Playwright and documented with PR screenshots.

---

# Epic 6 — AI-Assisted Investigation

## SENTRA-17 — Start Finding Investigation

### User Story

As a project member, I want to start an AI-assisted investigation for a finding so that I can quickly understand its relevance and supporting evidence.

### Context

The AI layer should operate as an investigation system, not an unrestricted chatbot. It must work through approved tools and tenant-scoped domain services.

### Acceptance Criteria

- A user can start an investigation from an authorized finding.
- The investigation is associated with the correct tenant, project, finding, and user.
- AI processing can occur asynchronously.
- Investigation status can be retrieved.
- Model/provider failures result in a safe failed state rather than losing the request.
- Investigation creation generates appropriate audit/telemetry data.

---

## SENTRA-18 — Tenant-Safe AI Investigation Tools

### User Story

As a Sentra user, I want AI investigations to use only authorized tenant data and approved security intelligence so that the AI cannot bypass application access controls.

### Context

The model must not receive direct database access. AI tools should call tenant-aware domain services that enforce authorization, limits, and auditability.

### Acceptance Criteria

- The AI model cannot execute arbitrary SQL or directly query application databases.
- AI tools use explicit typed inputs and outputs.
- Every tenant-specific tool operation is scoped to the investigation tenant.
- Tool calls enforce authorization independently of model instructions.
- Relevant tool calls are observable or auditable.
- Untrusted retrieved content is treated as data, not as trusted instructions.
- Tool failures are returned to the harness safely.
- Cross-tenant access tests exist.

---

## SENTRA-19 — Generate Evidence-Based Investigation Summary

### User Story

As a project member, I want Sentra to explain a finding using evidence from my project and trusted security data so that I can understand why it matters and what to do next.

### Context

The AI response should distinguish between retrieved facts, deterministic risk information, and model-generated explanation.

### Acceptance Criteria

- A completed investigation provides a concise summary of the vulnerability and tenant impact.
- The response references the tenant dependency/finding used as evidence.
- Relevant vulnerability intelligence is included in the investigation context.
- The output communicates uncertainty when required information is missing.
- The model does not invent tenant assets or vulnerability facts that are not available through tools.
- Investigation results are persisted for later viewing.
- Model inputs/outputs are handled according to the project's security and logging rules.

---

# Epic 7 — Auditability and Security Controls

## SENTRA-20 — Audit Log

### User Story

As an organization administrator, I want to review important organization activity so that security-sensitive actions are traceable.

### Context

Auditability is a core requirement for a SOC 2-aligned architecture. The MVP does not need a complete compliance system, but meaningful actions should produce structured audit events.

### Acceptance Criteria

- Important events such as organization creation, project creation, SBOM upload, membership changes, and investigation creation generate audit entries.
- Audit records include actor, tenant, action, target/resource, timestamp, and result where applicable.
- Audit records are tenant-scoped.
- Users cannot modify audit events through normal application APIs.
- Organization admins can retrieve their organization's audit history.
- Audit records do not expose secrets or unnecessary sensitive payloads.

---

## SENTRA-21 — Tenant Isolation Regression Suite

### User Story

As a Sentra operator, I want automated regression coverage for tenant boundaries so that future changes do not accidentally expose another organization's data.

### Context

Tenant isolation failures are high-severity defects. They deserve dedicated regression coverage rather than relying only on endpoint unit tests.

### Acceptance Criteria

- Automated tests attempt cross-tenant access to projects.
- Automated tests attempt cross-tenant access to uploads/assets.
- Automated tests attempt cross-tenant access to findings.
- Automated tests attempt cross-tenant access to investigations.
- Automated tests attempt cross-tenant access to audit records.
- Tests verify both read and relevant mutation operations.
- A failure in tenant isolation causes the canonical test/check command to fail.

---

# Epic 8 — Observability and Operations

## SENTRA-22 — Structured Logging and Correlation IDs

### User Story

As a Sentra operator, I want requests and background jobs to emit structured, correlated logs so that failures can be traced across system boundaries.

### Context

Distributed workflows become difficult to debug without consistent identifiers and structured telemetry.

### Acceptance Criteria

- API requests receive or propagate a request/correlation identifier.
- Background jobs and events propagate relevant correlation identifiers.
- Logs are structured.
- Tenant identifiers are included where safe and useful.
- Secrets and sensitive raw payloads are not logged.
- A request can be traced through at least the API and one asynchronous workflow using identifiers.

---

## SENTRA-23 — MVP Metrics and Health Checks

### User Story

As a Sentra operator, I want service health and basic performance metrics so that I can detect failures and establish a performance baseline.

### Context

Observability should exist before serious load testing begins.

### Acceptance Criteria

- Application services expose appropriate liveness/readiness or health endpoints.
- Metrics include request count, error count/rate, and request latency.
- Background processing exposes job success/failure or throughput metrics.
- Queue/backlog metrics are available where applicable.
- External-source ingestion failures can be identified operationally.
- Metrics can be viewed through the selected local observability stack.

---

# Epic 9 — Developer and Deployment Foundation

## SENTRA-24 — Local Development Stack

### User Story

As a developer, I want to run the MVP dependencies locally with a repeatable command so that development and testing do not depend on manually configured services.

### Context

Sentra should use local/open-source infrastructure during development. The stack should remain minimal and should not introduce Kubernetes for the MVP.

### Acceptance Criteria

- The required MVP infrastructure can be started locally through documented repo commands.
- PostgreSQL, object storage, event infrastructure, cache if required, and observability dependencies have reproducible local configuration.
- Persistent local data is clearly separated from source-controlled files.
- Service health can be checked.
- Secrets are not committed to the repository.
- Startup and shutdown instructions are documented.
- The implementation uses the repository's canonical Task workflow.

---

## SENTRA-25 — CI Quality Gate

### User Story

As a developer, I want pull requests to run the same canonical checks used locally so that code cannot be merged when required quality checks fail.

### Context

CI should invoke repository-owned Task commands rather than duplicating complex command logic in CI configuration.

### Acceptance Criteria

- Pull requests execute the repository's canonical formatting check.
- Pull requests execute linting.
- Pull requests execute type checking.
- Pull requests execute unit/regression tests.
- Required secret/security checks run where appropriate.
- CI uses pinned/reproducible tool versions.
- A failing required check prevents the PR from being considered ready to merge.
- CI commands match documented local developer commands.

---

# Epic 10 — Initial Scale Baseline

## SENTRA-26 — Define MVP SLOs and Performance Baseline

### User Story

As an engineer, I want explicit MVP performance targets so that scalability decisions can be based on measured behavior rather than intuition.

### Context

The long-term goal is to evolve Sentra through progressively larger workloads. The MVP only needs a baseline and a repeatable measurement process.

### Acceptance Criteria

- Initial latency, throughput, and error-rate targets are documented.
- The measurement includes p50, p95, and p99 latency where applicable.
- The repository documents which workload is being measured.
- Baseline infrastructure/resource assumptions are recorded.
- Results are stored under `docs/scaling/`.
- No premature architecture changes are made solely to satisfy hypothetical future traffic.

---

## SENTRA-27 — Create Initial k6 Workload

### User Story

As an engineer, I want a repeatable load test for the main API workflow so that I can establish how the MVP behaves as concurrency increases.

### Context

This is the starting point for later tests at 10, 100, 1,000, 10,000, and larger simulated user populations.

The MVP does not need to prove internet-scale capacity yet.

### Acceptance Criteria

- A k6 test exercises at least one representative authenticated read workflow.
- Test configuration supports increasing virtual-user counts without rewriting the scenario.
- Results capture throughput, latency percentiles, and errors.
- The initial baseline is run at small user counts such as 10 and 100.
- Results and observed bottlenecks are documented under `docs/scaling/`.
- Test data does not depend on production secrets or external tenant data.
- The load test can be run through the repository's canonical Task commands.

---

# Suggested MVP Sequence

The exact issue order may change as implementation reveals dependencies, but a sensible first pass is:

1. SENTRA-1 — User Sign-In
2. SENTRA-2 — Create Organization
3. SENTRA-3 — Organization Membership and Roles
4. SENTRA-4 — Create Security Project
5. SENTRA-24 — Local Development Stack
6. SENTRA-7 — Ingest OSV Vulnerability Data
7. SENTRA-8 — Ingest CISA KEV Data
8. SENTRA-9 — Ingest GitHub Security Advisory Data
9. SENTRA-10 — Schedule and Track Ingestion Jobs
10. SENTRA-11 — Normalize Vulnerability Records
11. SENTRA-12 — Deduplicate and Correlate Vulnerability Sources
12. SENTRA-5 — Upload SBOM
13. SENTRA-6 — Parse SBOM Dependencies
14. SENTRA-13 — Match Dependencies to Vulnerabilities
15. SENTRA-14 — Calculate MVP Risk Priority
16. SENTRA-15 — Findings List
17. SENTRA-16 — Finding Detail
18. SENTRA-20 — Audit Log
19. SENTRA-21 — Tenant Isolation Regression Suite
20. SENTRA-22 — Structured Logging and Correlation IDs
21. SENTRA-23 — MVP Metrics and Health Checks
22. SENTRA-17 — Start Finding Investigation
23. SENTRA-18 — Tenant-Safe AI Investigation Tools
24. SENTRA-19 — Generate Evidence-Based Investigation Summary
25. SENTRA-25 — CI Quality Gate
26. SENTRA-26 — Define MVP SLOs and Performance Baseline
27. SENTRA-27 — Create Initial k6 Workload

---

# Explicitly Out of Scope for MVP

These should be tracked as future work rather than added automatically:

- predictive ML models
- advanced data warehouse analytics
- ClickHouse/dbt production marts beyond minimal foundations
- Kubernetes
- sharding
- multi-region deployment
- billing/subscriptions
- complex enterprise SSO
- fine-grained ABAC/policy engines
- automatic remediation
- arbitrary AI agents with write access
- additional vulnerability ecosystems beyond the initial supported sources
- 100k+ concurrent-user proof
- 10M-user physical load generation
- advanced chaos engineering
- full SOC 2 certification
