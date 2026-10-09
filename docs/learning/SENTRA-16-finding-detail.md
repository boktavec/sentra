# SENTRA-16: Finding detail

Spec: [docs/features/SENTRA-16-finding-detail/spec.md](../features/SENTRA-16-finding-detail/spec.md).

## What was built

`GET /v1/orgs/:orgId/projects/:slug/findings/:findingId` returns one grouped finding: the list item the group leads with, every member finding with its advisory (details, refs, the affected entries for this package), the matcher evidence, and KEV catalog details. The web page at `.../findings/:findingId` turns the stored evidence into readable text, labels resolved findings and withdrawn advisories, and says "Sentra priority is not yet calculated" because scoring belongs to SENTRA-14.

## Why it is designed this way

- **One SQL, two consumers.** The detail header runs the list query itself with a different "which findings form the group" filter (`finding-sql.ts`). Lead selection, group CVSS and KEV status therefore cannot drift between list and detail.
- **Authorize first, expand second.** The scoped lookup (`org_id`, `project_id`, `id`) runs before the group is expanded, so advisory and KEV data, which are global, are reachable only through a finding the caller may read. Malformed, unknown, other-project and other-tenant IDs are the same 404.
- **The API returns facts, the web writes sentences.** Evidence is returned unchanged; the formatter knows the matcher's rules and falls back to raw JSON for anything new, so a matcher change never hides data.
- **Untrusted advisory text.** Advisory text and refs come from third parties. They render only as React text, links must parse as http(s), and the response is capped (50 members, 50 refs, 64 KiB of UTF-8 bytes of details, 200 versions) with explicit `truncated` flags.
- **Package filter uses the correlator's predicate.** Affected entries are joined through `sbom_dependencies` on ecosystem and `match_name`, never by comparing purls as strings (PyPI `Trac` matches `trac`).

## Alternatives considered

Blocking on SENTRA-14 for a score; a group-level ID in the URL; Markdown rendering (a new dependency); API-composed explanation text; pagination inside the detail resource.

## Tradeoffs

- The page shows the current grouping, not the grouping when a link was made.
- The caps are assumptions. The local corpus (16 real advisories) is too small to validate them.
- Without a `loading.tsx` the page has no streaming skeleton, but unknown IDs return a real HTTP 404. With one, Next sends 200 before `notFound()` runs.
- The byte cap is applied in two steps: SQL cuts at 64Ki characters (bounding what is fetched), then the API trims to 64 KiB at a character boundary.

## Scaling implications

Local benchmark (25,052 findings, one group at the caps): detail p95 about 33 ms; list p95 unchanged at about 75 ms. The detail uses five indexed queries (scope, header, members, affected, KEV when listed); the header scans the project's findings through the existing `(project_id, purl, vulnerability_id)` unique index.

## Failure and security considerations

No evidence, purls or advisory text is logged. The pipeline validates references as an array of objects with string type and url, but the API still treats a non-array `refs` as empty rather than failing. The URL scheme is the one unvalidated part, hence the http(s) allowlist.

## Key concepts

Authorize before expanding; share SQL rather than re-implement rules; treat third-party content as hostile in size and in markup; keep derived priority separate from source facts.
