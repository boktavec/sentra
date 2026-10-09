# SENTRA-15: Findings list

## What was built

A dedicated project Findings page reads the tenant-scoped API and shows grouped vulnerability issues with dependency, source, match quality, CVSS severity, KEV context, and status. The API filters, sorts, and pages before returning rows. Advisory normalization stores derived CVSS scores and an operator backfill handles existing data.

## Why this design

The browser never decides which tenant's findings to read; the API checks membership and project scope. SENTRA-12's groups are retained so overlapping advisories appear as one issue, while source provenance stays visible. CVSS is a standard severity signal; Sentra's broader risk priority remains separate. The score is global advisory data, so storing it once on `vulnerabilities` avoids copies across tenants.

## Alternatives and tradeoffs

Scoring on every page load would make server-side severity sorting costly. Copying scores to findings could be faster for very large projects, but would create a synchronization problem for advisory updates. Selecting only the canonical advisory's score would be cheaper but could hide a scored group member. The chosen group lookup adds query work; a 25,000-finding synthetic benchmark showed comfortable headroom on the local stack.

## Scaling, failure, and security

The API uses keyset pagination, capped page size, parameterized filters, and an org/project-scoped query. A score or group change can move a row between pages; Refresh restarts the list. Invalid vectors yield an explicit unavailable state and do not hide findings. An absent or stale KEV linkage is not interpreted as proof that exploitation is absent. A completed catalog snapshot is required before displaying a negative lookup, which is worded as not listed in the ingested catalog. API outages show an error with a correlation reference.

## Key concepts

- **Derived versus source data:** keep the raw CVSS vector and store a recomputable base score beside it.
- **Group read model:** one visible issue may have several advisories; its score needs an explicit aggregation and provenance rule.
- **Keyset pagination:** a cursor names the last sort key and is tied to the current filters, avoiding unbounded offsets.
- **Tenant boundary:** hiding another tenant's rows in the UI is insufficient; authorization and project filtering belong in the API.
