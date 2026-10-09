import type { Pool } from "pg";
import { toPage } from "./org-input.ts";
import type { TenantContext } from "./orgs.ts";
import { projectPageParams } from "./projects.ts";

interface FindingRow {
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
  cursor_ts: string;
}

const toFinding = (row: FindingRow) => ({
  id: row.id,
  purl: row.purl,
  version: row.version,
  ecosystem: row.ecosystem,
  scope: row.scope,
  status: row.status,
  resolvedReason: row.resolved_reason,
  resolvedAt: row.resolved_at?.toISOString() ?? null,
  matchQuality: row.match_quality,
  matchReason: row.match_reason,
  firstSeenAt: row.first_seen_at.toISOString(),
  lastSeenAt: row.last_seen_at.toISOString(),
  importId: row.import_id,
  evidence: row.evidence,
  vulnerability: {
    id: row.vulnerability_id,
    groupId: row.group_id,
    source: row.source,
    sourceId: row.source_id,
    aliases: row.aliases,
    summary: row.summary,
    severity: row.severity,
  },
  sources: row.sources,
});

/** Reads findings, which the correlator (services/pipeline) writes. The API never changes them. */
export function createFindingStore(pool: Pool) {
  return {
    /**
     * One item per dependency (purl) and issue, newest first. An issue is a vulnerability group
     * (SENTRA-12); an advisory the grouper has not reached yet is its own issue, so grouper lag never
     * hides a finding. The item is led by one finding (open over resolved, confirmed over unverifiable,
     * then the oldest) and its times span every finding of the issue. `vulnerability` is the group's
     * canonical advisory and `sources` lists every advisory in the group, so provenance stays visible.
     * The org filter repeats the one the project lookup already applied, so a finding of another
     * tenant can never be returned even if a project ID were somehow shared.
     * ponytail: the window pass reads every finding of the project per page; add a stored
     * group key on findings if a project's findings are ever measured in the hundreds of thousands.
     */
    async list(tenant: TenantContext, slug: string, limit: number, cursor?: string) {
      const { rows } = await pool.query<FindingRow>(
        `WITH base AS (
           SELECT f.*, m.group_id, COALESCE(m.group_id, f.vulnerability_id) AS gid
           FROM findings f
           LEFT JOIN vulnerability_group_members m ON m.vulnerability_id = f.vulnerability_id
           WHERE f.org_id = $1 AND f.project_id = $2
         ), leads AS (
           SELECT DISTINCT ON (purl, gid) base.*,
                  min(first_seen_at) OVER w AS group_first_seen_at,
                  max(last_seen_at) OVER w AS group_last_seen_at
           FROM base WINDOW w AS (PARTITION BY purl, gid)
           ORDER BY purl, gid, (status = 'open') DESC, (match_quality = 'confirmed') DESC, first_seen_at, id
         )
         SELECT l.id, l.purl, l.version, l.ecosystem, l.scope, l.status, l.resolved_reason, l.resolved_at,
                l.match_quality, l.match_reason, l.group_first_seen_at AS first_seen_at,
                l.group_last_seen_at AS last_seen_at, l.import_id, l.evidence, l.group_id,
                v.id AS vulnerability_id, v.source, v.source_id, v.aliases, v.summary, v.severity,
                src.sources, l.group_first_seen_at::text AS cursor_ts
         FROM leads l
         LEFT JOIN vulnerability_groups g ON g.id = l.group_id
         JOIN vulnerabilities v ON v.id = COALESCE(g.canonical_vulnerability_id, l.vulnerability_id)
         CROSS JOIN LATERAL (
           SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'source', s.source,
                    'sourceId', s.source_id, 'aliases', s.aliases) ORDER BY s.source, s.source_id), '[]') AS sources
           FROM vulnerabilities s
           WHERE s.id = l.vulnerability_id
              OR s.id IN (SELECT vulnerability_id FROM vulnerability_group_members WHERE group_id = l.group_id)
         ) src
         WHERE ($3::timestamptz IS NULL
                OR l.group_first_seen_at < $3::timestamptz
                OR (l.group_first_seen_at = $3::timestamptz AND l.id > $4::uuid))
         ORDER BY l.group_first_seen_at DESC, l.id
         LIMIT $5`,
        await projectPageParams(pool, tenant, slug, limit, cursor),
      );
      return toPage(rows, limit, toFinding);
    },
  };
}

export type FindingStore = ReturnType<typeof createFindingStore>;
