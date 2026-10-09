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

### Derived CVSS fields (SENTRA-15)

The canonical `severity[]` vectors remain source evidence. Normalization also stores nullable `cvss_score`, `cvss_version`, and `cvss_calculated_at` on the global `vulnerabilities` row. It selects the highest supported **valid version** (v4.0, then v3.1, then v3.0), calculates the standard base score with `cvss` 3.6, and leaves score/version null when no usable vector exists. The operator backfill `task pipeline:normalize:cvss-backfill` processes older rows in bounded batches after migration 013. These columns are derived storage, not new fields in the versioned source contract, and do not represent tenant-specific risk priority. See the [SENTRA-15 spec](../../docs/features/SENTRA-15-findings-list/spec.md).

## Risk priority (SENTRA-14; model version 1; [ADR 0008](../../docs/adr/0008-read-time-rule-based-risk-priority.md))

Sentra priority is derived at read time per grouped finding and returned as `priority` on list items and the detail. It is never stored. Rules are evaluated in order:

| Step | Rule | `baseReason` |
| --- | --- | --- |
| Base | KEV status `listed` gives P1 | `kev_listed` |
| Base | else group CVSS >= 7.0 gives P2 | `cvss_high` |
| Base | else 4.0 <= CVSS < 7.0 gives P3 | `cvss_medium` |
| Base | else CVSS unavailable gives P3 | `cvss_unavailable` |
| Base | else CVSS < 4.0 gives P4 | `cvss_low` |
| Exposure | lead scope `optional` or `excluded` lowers the tier by one, never below P4; `scopeAdjusted` is true only if the tier changed | |
| Match quality | `unverifiable` does not change the tier; reported as a factor | |
| KEV unavailable | no completed catalog or no CVE linkage is scored as not listed; reported as `unavailable`, never as "not exploited" | |

`factors` repeats `kev`, `cvss` (score and category), `scope` and `matchQuality` so the explanation is self-contained. The API returns codes; the web writes the sentences. Status does not affect the tier. `sort=priority` (the default list order) is tier, then group CVSS descending (unscored last), then group first-seen descending, then id. Any change to a rule, threshold or input bumps `modelVersion`.

## CISA KEV mapping (built in SENTRA-8; [ADR 0004](../../docs/adr/0004-kev-as-enrichment-plus-linked-vulnerability-rows.md))

KEV is stored twice: the full entry in `kev_entries` (the source of truth for "is it in KEV"), and a linked canonical row below. Field names were **Verified** against the live catalog on 2026-10-08; the catalog also has `cwes`, `forensicTriage`, `requiredAction`, `dueDate`, `knownRansomwareCampaignUse` and `notes`.

| KEV | Canonical |
| --- | --- |
| `cveID` | `sourceId` (`source` = `cisa-kev`) |
| `vulnerabilityName`, `shortDescription` | `summary`, `details` (trimmed: the feed pads some names) |
| `dateAdded` | `publishedAt` and `modifiedAt` (the catalog has no per-record modified time) |
| `vendorProject` + `product` | not mapped: no `affected` entries, so the row never matches a dependency |
| "known exploited" | `kev_entries` and the `vulnerability_kev_status` view, not a model field |

An entry that cannot be mapped (bad CVE ID or date) is quarantined; its CVE still counts as listed, so it is not tombstoned.

## GitHub Security Advisory mapping (documented, not built; **Assumed** until SENTRA-9)

| GHSA | Canonical |
| --- | --- |
| `ghsa_id` | `sourceId` (`source` = `ghsa`) |
| `cve_id`, `identifiers` | `aliases` |
| `summary`, `description`, `published_at`, `updated_at`, `withdrawn_at` | `summary`, `details`, `publishedAt`, `modifiedAt`, `withdrawnAt` |
| `vulnerabilities[].package` | `affected[]` `{ecosystem, packageName}` |
| `vulnerabilities[].vulnerable_version_range` (`>= 1.0, < 1.4.2`) | `ranges[].events`: `introduced` / `fixed` / `last_affected` |
| `severity`, `cvss` | `severity[]` |
