# Sentra Product Context

## Product

Sentra is a multi-tenant security intelligence platform that helps organizations understand software supply-chain risk.

The MVP combines tenant-provided software inventories with external vulnerability intelligence and presents prioritized findings with AI-assisted investigation.

## Primary MVP Workflow

```text
User signs in
    |
Creates organization
    |
Creates project
    |
Uploads SBOM
    |
Dependencies are normalized
    |
External vulnerability data is ingested
    |
Dependencies are correlated with vulnerabilities
    |
Findings are prioritized
    |
User reviews findings
    |
User can launch an AI-assisted investigation
```

## Initial External Data Sources

MVP sources:
- OSV
- CISA Known Exploited Vulnerabilities
- GitHub Security Advisories

Future sources may include:
- npm/PyPI/package ecosystem metadata
- repository activity
- security blogs
- exploit intelligence
- additional tenant asset sources

## Core MVP Capabilities

- authentication
- organizations and tenant isolation
- projects
- SBOM upload
- dependency extraction
- vulnerability ingestion
- raw-data preservation
- normalization/deduplication
- dependency-to-vulnerability correlation
- deterministic risk prioritization
- findings list/detail
- AI-assisted investigation
- audit logging
- basic observability
- CI quality gates
- initial load testing

## Non-Goals for MVP

Do not expand the MVP into:
- predictive ML
- autonomous remediation
- Kubernetes
- database sharding
- multi-region architecture
- billing
- complex enterprise SSO
- advanced warehouse marts
- dozens of data sources
- full SOC 2 certification
- arbitrary write-capable agents

These may become later phases.

## Product Principles

- Evidence should be traceable to source data.
- AI should explain and investigate; it should not be the source of truth.
- Users should be able to understand why a finding exists and why it is prioritized.
- Security boundaries must not depend on model behavior.
- Features should remain useful without requiring AI.
