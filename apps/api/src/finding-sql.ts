// SQL shared by the findings list and the finding detail, so the two cannot disagree about which
// finding leads a group, what its CVSS score is, or whether it is in the KEV catalog.

export type SeverityCategory = "critical" | "high" | "medium" | "low" | "none" | "unavailable";

export function category(value: number | null): SeverityCategory {
  if (value === null) return "unavailable";
  if (value === 0) return "none";
  if (value < 4) return "low";
  if (value < 7) return "medium";
  if (value < 9) return "high";
  return "critical";
}

export interface FindingRow {
  id: string;
  purl: string;
  version: string;
  ecosystem: string;
  scope: string;
  status: string;
  resolved_reason: string | null;
  resolved_at: Date | null;
  match_quality: string;
  match_reason: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  import_id: string;
  evidence: unknown;
  vulnerability_id: string;
  group_id: string | null;
  sources: { id: string; source: string; sourceId: string; aliases: string[] }[];
  source: string;
  source_id: string;
  aliases: string[];
  summary: string | null;
  severity: unknown;
  cvss_score: string | null;
  cvss_version: string | null;
  cvss_source: string | null;
  cvss_source_id: string | null;
  kev_status: "listed" | "not_listed" | "unavailable";
  cursor_ts: string;
}

/** The finding's own advisory plus every advisory in its group. `row` needs vulnerability_id and group_id. */
export const advisoriesOfGroup = (row: string) =>
  `(a.id = ${row}.vulnerability_id OR a.id IN
    (SELECT vulnerability_id FROM vulnerability_group_members WHERE group_id = ${row}.group_id))`;

/** An active KEV entry for `a`, matched on its own id or any alias. */
export const KEV_ENTRY_MATCHES_ADVISORY =
  "k.removed_at IS NULL AND k.cve_id = ANY(a.aliases || a.source_id)";

const kevStatusSql = (row: string) => `CASE
  WHEN NOT EXISTS (SELECT 1 FROM normalization_runs nr
    WHERE nr.source = 'cisa-kev' AND nr.status IN ('completed', 'published')) THEN 'unavailable'
  WHEN NOT EXISTS (
    SELECT 1 FROM vulnerabilities a,
      unnest(a.aliases || a.source_id) AS ids(identifier)
    WHERE ${advisoriesOfGroup(row)}
      AND identifier ~ '^CVE-[0-9]{4}-[0-9]{4,}$'
  ) THEN 'unavailable'
  WHEN EXISTS (
    SELECT 1 FROM vulnerabilities a JOIN kev_entries k ON ${KEV_ENTRY_MATCHES_ADVISORY}
    WHERE ${advisoriesOfGroup(row)}
  ) THEN 'listed' ELSE 'not_listed'
END`;

interface FindingSqlParts {
  /** Which findings form the groups; aliases: `f` findings, `m` vulnerability_group_members. */
  baseWhere: string;
  /** Filters on the grouped result; alias `s`. */
  where: string[];
  /** ORDER BY over alias `s`. */
  order: string;
  /** SQL expression for the row limit. */
  limit: string;
}

/** One row per (dependency, advisory group), led by the finding that best represents the group. */
export function findingSql({ baseWhere, where, order, limit }: FindingSqlParts): string {
  return `WITH base AS (
           SELECT f.*, m.group_id, COALESCE(m.group_id, f.vulnerability_id) AS gid
           FROM findings f
           LEFT JOIN vulnerability_group_members m ON m.vulnerability_id = f.vulnerability_id
           WHERE ${baseWhere}
         ), leads AS (
           SELECT DISTINCT ON (purl, gid) base.*,
                  min(first_seen_at) OVER w AS group_first_seen_at,
                  max(last_seen_at) OVER w AS group_last_seen_at
           FROM base WINDOW w AS (PARTITION BY purl, gid)
           ORDER BY purl, gid, (status = 'open') DESC, (match_quality = 'confirmed') DESC, first_seen_at, id
         ), scored AS (
           SELECT l.*, sev.cvss_score, sev.cvss_version,
                  sev.source AS cvss_source, sev.source_id AS cvss_source_id
           FROM leads l
           LEFT JOIN LATERAL (
             SELECT a.cvss_score, a.cvss_version, a.source, a.source_id
             FROM vulnerabilities a
             WHERE ${advisoriesOfGroup("l")}
               AND a.cvss_score IS NOT NULL
             ORDER BY a.cvss_score DESC, a.cvss_version DESC, a.source, a.source_id
             LIMIT 1
           ) sev ON true
         ), paged AS (
           SELECT s.* FROM scored s
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY ${order}
           LIMIT ${limit}
         )
         SELECT p.id, p.purl, p.version, p.ecosystem, p.scope, p.status, p.resolved_reason, p.resolved_at,
                p.match_quality, p.match_reason, p.group_first_seen_at AS first_seen_at,
                p.group_last_seen_at AS last_seen_at, p.import_id, p.evidence, p.group_id,
                p.cvss_score, p.cvss_version, p.cvss_source, p.cvss_source_id,
                v.id AS vulnerability_id, v.source, v.source_id, v.aliases, v.summary, v.severity,
                src.sources, p.group_first_seen_at::text AS cursor_ts,
                ${kevStatusSql("p")} AS kev_status
         FROM paged p
         LEFT JOIN vulnerability_groups g ON g.id = p.group_id
         JOIN vulnerabilities v ON v.id = COALESCE(g.canonical_vulnerability_id, p.vulnerability_id)
         CROSS JOIN LATERAL (
           SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'source', a.source,
                    'sourceId', a.source_id, 'aliases', a.aliases) ORDER BY a.source, a.source_id), '[]') AS sources
           FROM vulnerabilities a
           WHERE ${advisoriesOfGroup("p")}
         ) src
         ORDER BY ${order.replaceAll("s.", "p.")}`;
}
