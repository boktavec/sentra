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
    source: row.source,
    sourceId: row.source_id,
    aliases: row.aliases,
    summary: row.summary,
    severity: row.severity,
  },
});

/** Reads findings, which the correlator (services/pipeline) writes. The API never changes them. */
export function createFindingStore(pool: Pool) {
  return {
    /**
     * Newest first. The org filter repeats the one the project lookup already applied, so a finding of
     * another tenant can never be returned even if a project ID were somehow shared.
     */
    async list(tenant: TenantContext, slug: string, limit: number, cursor?: string) {
      const { rows } = await pool.query<FindingRow>(
        `SELECT f.id, f.purl, f.version, f.ecosystem, f.scope, f.status, f.resolved_reason, f.resolved_at,
                f.match_quality, f.match_reason, f.first_seen_at, f.last_seen_at, f.import_id, f.evidence,
                v.id AS vulnerability_id, v.source, v.source_id, v.aliases, v.summary, v.severity,
                f.first_seen_at::text AS cursor_ts
         FROM findings f JOIN vulnerabilities v ON v.id = f.vulnerability_id
         WHERE f.org_id = $1 AND f.project_id = $2
           AND ($3::timestamptz IS NULL
                OR f.first_seen_at < $3::timestamptz
                OR (f.first_seen_at = $3::timestamptz AND f.id > $4::uuid))
         ORDER BY f.first_seen_at DESC, f.id
         LIMIT $5`,
        await projectPageParams(pool, tenant, slug, limit, cursor),
      );
      return toPage(rows, limit, toFinding);
    },
  };
}

export type FindingStore = ReturnType<typeof createFindingStore>;
