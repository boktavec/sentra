import type { Pool } from "pg";
import { AppError } from "@sentra/ts-platform";
import {
  advisoriesOfGroup,
  category,
  findingSql,
  KEV_ENTRY_MATCHES_ADVISORY,
  toPriority,
} from "./finding-sql.ts";
import type { FindingRow } from "./finding-sql.ts";
import { isUuid } from "./org-input.ts";
import type { TenantContext } from "./orgs.ts";
import { findProject } from "./projects.ts";

// Advisory content is third-party controlled, so every part of the response is bounded and says when it
// was cut (see the SENTRA-16 spec, D5). The values are assumptions to validate against real data.
const MAX_MEMBERS = 50;
const MAX_REFS = 50;
const MAX_DETAILS_BYTES = 64 * 1024;
const MAX_VERSIONS = 200;

const missing = () => new AppError("not_found", 404, "Not found", { reason: "finding_not_found" });

/** The findings of one (dependency, advisory group); `m` is the advisory's group membership. */
const GROUP_FINDINGS =
  "f.org_id = $1 AND f.project_id = $2 AND f.purl = $3 AND COALESCE(m.group_id, f.vulnerability_id) = $4";

const MEMBERS_SQL = `
  WITH ranked AS (
    SELECT f.*,
           row_number() OVER (ORDER BY (f.status = 'open') DESC, (f.match_quality = 'confirmed') DESC,
                                       f.first_seen_at, f.id) AS rank,
           count(*) OVER () AS total
    FROM findings f
    LEFT JOIN vulnerability_group_members m ON m.vulnerability_id = f.vulnerability_id
    WHERE ${GROUP_FINDINGS}
  )
  SELECT r.id, r.status, r.resolved_reason, r.resolved_at, r.first_seen_at, r.last_seen_at, r.import_id,
         r.match_quality, r.match_reason, r.matcher_version, r.evidence, r.total::int AS total,
         v.id AS advisory_id, v.source, v.source_id, v.aliases, v.summary,
         left(v.details, ${MAX_DETAILS_BYTES}) AS details,
         octet_length(v.details) > ${MAX_DETAILS_BYTES} AS details_truncated,
         v.published_at, v.modified_at, v.withdrawn_at, v.cvss_score, v.cvss_version,
         CASE WHEN jsonb_typeof(v.refs) = 'array'
              THEN jsonb_path_query_array(v.refs, '$[0 to ${MAX_REFS - 1}]') ELSE '[]' END AS refs,
         COALESCE(jsonb_typeof(v.refs) = 'array' AND jsonb_array_length(v.refs) > ${MAX_REFS}, false) AS refs_truncated
  FROM ranked r
  JOIN vulnerabilities v ON v.id = r.vulnerability_id
  WHERE r.rank <= ${MAX_MEMBERS} OR r.id = $5
  ORDER BY r.rank`;

/**
 * Affected entries for the member's own package only. The join is the correlator's predicate
 * (ecosystem + match_name through the dependency row), never a raw purl comparison.
 */
const AFFECTED_SQL = `
  SELECT f.id AS finding_id, a.package_name,
         a.versions[1:${MAX_VERSIONS}] AS versions,
         cardinality(a.versions) > ${MAX_VERSIONS} AS versions_truncated,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object('type', r.range_type, 'events', r.events) ORDER BY r.range_index)
           FROM (
             SELECT range_index, range_type,
                    jsonb_agg(jsonb_build_object('type', event_type, 'version', event_version)
                              ORDER BY event_index) AS events
             FROM vulnerability_ranges WHERE affected_id = a.id GROUP BY range_index, range_type
           ) r
         ), '[]') AS ranges
  FROM findings f
  JOIN sbom_dependencies d ON d.import_id = f.import_id AND d.purl = f.purl
  JOIN vulnerability_affected a ON a.vulnerability_id = f.vulnerability_id
       AND a.ecosystem = d.ecosystem AND a.match_name = d.match_name
  WHERE f.org_id = $1 AND f.project_id = $2 AND f.id = ANY($3::uuid[])
  ORDER BY f.id, a.package_name, a.id`;

/** `$1` stands for both the advisory and the group id, so the group-advisory predicate applies to either. */
const KEV_SQL = `
  SELECT DISTINCT k.cve_id, k.vendor_project, k.product, k.name, k.date_added::text AS date_added,
         k.due_date::text AS due_date, k.known_ransomware_use, k.required_action, k.catalog_version
  FROM (SELECT $1::uuid AS vulnerability_id, $1::uuid AS group_id) g
  JOIN vulnerabilities a ON ${advisoriesOfGroup("g")}
  JOIN kev_entries k ON ${KEV_ENTRY_MATCHES_ADVISORY}
  ORDER BY k.cve_id`;

interface MemberRow {
  id: string;
  status: string;
  resolved_reason: string | null;
  resolved_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  import_id: string;
  match_quality: string;
  match_reason: string | null;
  matcher_version: number;
  evidence: unknown;
  total: number;
  advisory_id: string;
  source: string;
  source_id: string;
  aliases: string[];
  summary: string | null;
  details: string | null;
  details_truncated: boolean | null;
  published_at: Date | null;
  modified_at: Date;
  withdrawn_at: Date | null;
  cvss_score: string | null;
  cvss_version: string | null;
  refs: unknown[];
  refs_truncated: boolean;
}

interface AffectedRow {
  finding_id: string;
  package_name: string;
  versions: string[];
  versions_truncated: boolean;
  ranges: { type: string; events: { type: string; version: string }[] }[];
}

interface KevRow {
  cve_id: string;
  vendor_project: string | null;
  product: string | null;
  name: string | null;
  date_added: string;
  due_date: string | null;
  known_ransomware_use: string | null;
  required_action: string | null;
  catalog_version: string;
}

/**
 * The SQL cut `details` at MAX_DETAILS_BYTES characters, which can be up to four times as many bytes.
 * Cut to the byte cap without splitting a UTF-8 character.
 */
function capBytes(text: string | null): string | null {
  if (text === null) return null;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_DETAILS_BYTES) return text;
  let end = MAX_DETAILS_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** Refs are copied from the source unvalidated, so each part may be missing or not a string. */
function toRef(ref: unknown) {
  const { type, url } = (ref ?? {}) as { type?: unknown; url?: unknown };
  return {
    type: typeof type === "string" ? type : null,
    url: typeof url === "string" ? url : null,
  };
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

function toMember(row: MemberRow, affected: AffectedRow[]) {
  const cvssScore = row.cvss_score === null ? null : Number(row.cvss_score);
  return {
    id: row.id,
    status: row.status,
    resolvedReason: row.resolved_reason,
    resolvedAt: iso(row.resolved_at),
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    importId: row.import_id,
    matchQuality: row.match_quality,
    matchReason: row.match_reason,
    matcherVersion: row.matcher_version,
    evidence: row.evidence,
    advisory: {
      id: row.advisory_id,
      source: row.source,
      sourceId: row.source_id,
      aliases: row.aliases,
      summary: row.summary,
      details: capBytes(row.details),
      detailsTruncated: row.details_truncated === true,
      publishedAt: iso(row.published_at),
      modifiedAt: row.modified_at.toISOString(),
      withdrawnAt: iso(row.withdrawn_at),
      cvssScore,
      cvssVersion: row.cvss_version,
      refs: row.refs.map(toRef),
      refsTruncated: row.refs_truncated,
      affected: affected.map((a) => ({
        packageName: a.package_name,
        versions: a.versions,
        versionsTruncated: a.versions_truncated,
        ranges: a.ranges,
      })),
    },
  };
}

/**
 * One finding's whole group: the header is the list item the group leads with, plus every member
 * finding with its advisory. Any member id resolves to the same group. The scoped lookup runs first,
 * so an id from another tenant or project is a 404 before anything is expanded.
 */
export async function getFindingDetail(
  pool: Pool,
  tenant: TenantContext,
  slug: string,
  findingId: string,
) {
  if (!isUuid(findingId)) throw missing();
  const projectId = await findProject(pool, tenant, slug);
  const scope = await pool.query<{ purl: string; gid: string }>(
    `SELECT f.purl, COALESCE(m.group_id, f.vulnerability_id) AS gid
     FROM findings f
     LEFT JOIN vulnerability_group_members m ON m.vulnerability_id = f.vulnerability_id
     WHERE f.org_id = $1 AND f.project_id = $2 AND f.id = $3`,
    [tenant.orgId, projectId, findingId],
  );
  const group = scope.rows[0];
  if (!group) throw missing();

  const groupParams = [tenant.orgId, projectId, group.purl, group.gid];
  const [header, members] = await Promise.all([
    pool.query<FindingRow>(
      findingSql({ baseWhere: GROUP_FINDINGS, where: [], order: "s.id", limit: "1" }),
      groupParams,
    ),
    pool.query<MemberRow>(MEMBERS_SQL, [...groupParams, findingId]),
  ]);
  const lead = header.rows[0];
  if (!lead || members.rows.length === 0) throw missing();

  const memberIds = members.rows.map((m) => m.id);
  const [affected, kev] = await Promise.all([
    pool.query<AffectedRow>(AFFECTED_SQL, [tenant.orgId, projectId, memberIds]),
    lead.kev_status === "listed"
      ? pool.query<KevRow>(KEV_SQL, [group.gid])
      : Promise.resolve({ rows: null }),
  ]);
  const cvssScore = lead.cvss_score === null ? null : Number(lead.cvss_score);

  return {
    id: findingId,
    purl: lead.purl,
    version: lead.version,
    ecosystem: lead.ecosystem,
    scope: lead.scope,
    status: lead.status,
    firstSeenAt: lead.first_seen_at.toISOString(),
    lastSeenAt: lead.last_seen_at.toISOString(),
    groupId: lead.group_id,
    vulnerability: {
      id: lead.vulnerability_id,
      source: lead.source,
      sourceId: lead.source_id,
      aliases: lead.aliases,
      summary: lead.summary,
      cvssScore,
      cvssVersion: lead.cvss_version,
      severityCategory: category(cvssScore),
      cvssSource:
        lead.cvss_source && lead.cvss_source_id
          ? { source: lead.cvss_source, sourceId: lead.cvss_source_id }
          : null,
    },
    kevStatus: lead.kev_status,
    priority: toPriority(lead),
    kev:
      kev.rows?.map((k) => ({
        cveId: k.cve_id,
        vendorProject: k.vendor_project,
        product: k.product,
        name: k.name,
        dateAdded: k.date_added,
        dueDate: k.due_date,
        knownRansomwareUse: k.known_ransomware_use,
        requiredAction: k.required_action,
        catalogVersion: k.catalog_version,
      })) ?? null,
    members: members.rows.map((row) =>
      toMember(
        row,
        affected.rows.filter((a) => a.finding_id === row.id),
      ),
    ),
    membersTruncated: members.rows[0]!.total > members.rows.length,
  };
}
