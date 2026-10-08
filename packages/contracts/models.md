# Canonical models

Source adapters turn provider-specific records into these shapes. Everything after the adapter (validation, persistence, matching, UI) depends only on the canonical model, never on a provider schema. Each model has a versioned JSON Schema in [`models/`](models/); a record is persisted only if it validates. Design: [SENTRA-11 spec](../../docs/features/SENTRA-11-normalize-vulnerabilities/spec.md).

| Model | Schema | Tables |
| --- | --- | --- |
| `vulnerability` | [`vulnerability.v1.json`](models/vulnerability.v1.json) | `vulnerabilities`, `vulnerability_affected`, `vulnerability_ranges` |

## Versioning

- `schema_version` is the version of the model; `adapter_version` is the version of the code that produced the row. Both are stored on every row.
- A row is rewritten when the source's `modified` is newer **or** the adapter version is higher, so fixing an adapter and reprocessing the raw artifact migrates stale rows.
- A breaking model change adds `vulnerability.v2.json` and a migration; additive fields are not allowed in v1 (`additionalProperties: false`).

## Provenance

`source` and `sourceId` are the provider's own identifiers, never rewritten. Each row also records the raw artifact SHA-256 and the zip entry it was written from. Records that fail normalization are in `normalization_failures` with the same artifact and entry.

## OSV mapping (built)

| OSV | Canonical |
| --- | --- |
| `id` | `sourceId` (`source` = `osv`) |
| `aliases`, `summary`, `details`, `published`, `modified`, `withdrawn` | `aliases`, `summary`, `details`, `publishedAt`, `modifiedAt`, `withdrawnAt` |
| `severity[]` `{type, score}` | `severity[]` `{type, vector}` (OSV's `score` holds the vector string) |
| `references[]` | `references[]` |
| `affected[].package` `{ecosystem, name, purl}` | `affected[]` `{ecosystem, packageName, purl}`; an entry with no package is dropped |
| `affected[].versions` | `affected[].versions` |
| `affected[].ranges[]` of type `SEMVER` or `ECOSYSTEM` | `affected[].ranges[]` with the same events; `GIT` ranges are dropped (an SBOM has package versions, not commits) |
| `database_specific`, `credits`, `related` | not kept |

An unknown range type or event type is a normalization failure (quarantined), so a new OSV feature is noticed instead of silently ignored.

## CISA KEV mapping (documented, not built; **Assumed** until SENTRA-8)

| KEV | Canonical |
| --- | --- |
| `cveID` | `sourceId` (`source` = `cisa-kev`) |
| `vulnerabilityName`, `shortDescription` | `summary`, `details` |
| `dateAdded` | `publishedAt` |
| `vendorProject` + `product` | one `affected` entry with `ecosystem` = `vendor`, no versions or ranges |
| "known exploited" | a flag for risk priority (SENTRA-14); needs an additive model version when SENTRA-8 lands |

KEV has no per-record `modified`, so its update guard must be a content hash instead of a timestamp.

## GitHub Security Advisory mapping (documented, not built; **Assumed** until SENTRA-9)

| GHSA | Canonical |
| --- | --- |
| `ghsa_id` | `sourceId` (`source` = `ghsa`) |
| `cve_id`, `identifiers` | `aliases` |
| `summary`, `description`, `published_at`, `updated_at`, `withdrawn_at` | `summary`, `details`, `publishedAt`, `modifiedAt`, `withdrawnAt` |
| `vulnerabilities[].package` | `affected[]` `{ecosystem, packageName}` |
| `vulnerabilities[].vulnerable_version_range` (`>= 1.0, < 1.4.2`) | `ranges[].events`: `introduced` / `fixed` / `last_affected` |
| `severity`, `cvss` | `severity[]` |
