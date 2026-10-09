import type { Pool } from "pg";
import { AppError } from "@sentra/ts-platform";
import { isUuid } from "./org-input.ts";
import type { TenantContext } from "./orgs.ts";
import { findProject } from "./projects.ts";

export type FindingStatus = "open" | "resolved" | "all";
export type Severity = "critical" | "high" | "medium" | "low" | "none" | "unavailable" | "all";
export type FindingSort = "severity" | "newest";
export interface FindingQuery {
  status: FindingStatus;
  severity: Severity;
  sort: FindingSort;
  limit: number;
  cursor?: string;
}

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
  cvss_score: string | null;
  cvss_version: string | null;
  cvss_source: string | null;
  cvss_source_id: string | null;
  kev_status: "listed" | "not_listed" | "unavailable";
  cursor_ts: string;
}

const invalid = (reason: string) => new AppError("invalid_input", 400, "Invalid input", { reason });
const timestamp = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/;

function category(value: number | null): Exclude<Severity, "all"> {
  if (value === null) return "unavailable";
  if (value === 0) return "none";
  if (value < 4) return "low";
  if (value < 7) return "medium";
  if (value < 9) return "high";
  return "critical";
}

const toFinding = (row: FindingRow) => {
  const cvssScore = row.cvss_score === null ? null : Number(row.cvss_score);
  return {
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
      cvssScore,
      cvssVersion: row.cvss_version,
      severityCategory: category(cvssScore),
      cvssSource:
        row.cvss_source && row.cvss_source_id
          ? { source: row.cvss_source, sourceId: row.cvss_source_id }
          : null,
    },
    kevStatus: row.kev_status,
    sources: row.sources,
  };
};

interface Cursor {
  score: number | null;
  time: string;
  id: string;
}

function decodeCursor(query: FindingQuery): Cursor | null {
  if (!query.cursor) return null;
  if (query.cursor.length > 1024) throw invalid("cursor");
  try {
    const [sort, status, severity, score, time, id] = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString("utf8"),
    ) as unknown[];
    if (cursorMatches(query, sort, status, severity, score, time, id))
      return { score: score as number | null, time: time as string, id: id as string };
  } catch {
    // Invalid or mismatched cursors use the ordinary input error.
  }
  throw invalid("cursor");
}

function cursorMatches(query: FindingQuery, ...parts: unknown[]): boolean {
  const [sort, status, severity, score, time, id] = parts;
  return (
    sort === query.sort &&
    status === query.status &&
    severity === query.severity &&
    validCursorScore(score) &&
    validCursorPosition(time, id)
  );
}

function validCursorScore(score: unknown): boolean {
  return score === null || (typeof score === "number" && score >= 0 && score <= 10);
}

function validCursorPosition(time: unknown, id: unknown): boolean {
  return typeof time === "string" && timestamp.test(time) && typeof id === "string" && isUuid(id);
}

function encodeCursor(query: FindingQuery, row: FindingRow): string {
  return Buffer.from(
    JSON.stringify([
      query.sort,
      query.status,
      query.severity,
      row.cvss_score === null ? null : Number(row.cvss_score),
      row.cursor_ts,
      row.id,
    ]),
  ).toString("base64url");
}

const severityRange: Record<Exclude<Severity, "all" | "unavailable">, [number, number]> = {
  none: [0, 0],
  low: [0.1, 3.9],
  medium: [4, 6.9],
  high: [7, 8.9],
  critical: [9, 10],
};

function pageConditions(query: FindingQuery, after: Cursor | null, values: unknown[]): string[] {
  const where: string[] = [];
  if (query.status !== "all") {
    values.push(query.status);
    where.push(`s.status = $${values.length}`);
  }
  if (query.severity === "unavailable") {
    where.push("s.cvss_score IS NULL");
  } else if (query.severity !== "all") {
    const [min, max] = severityRange[query.severity];
    values.push(min, max);
    where.push(`s.cvss_score BETWEEN $${values.length - 1} AND $${values.length}`);
  }
  if (after) where.push(cursorCondition(query.sort, after, values));
  return where;
}

function cursorCondition(sort: FindingSort, after: Cursor, values: unknown[]): string {
  if (sort === "newest" || after.score === null) {
    values.push(after.time, after.id);
    const tie = `(s.group_first_seen_at < $${values.length - 1}::timestamptz OR
      (s.group_first_seen_at = $${values.length - 1}::timestamptz AND s.id > $${values.length}::uuid))`;
    return sort === "newest" ? tie : `(s.cvss_score IS NULL AND ${tie})`;
  }
  values.push(after.score, after.time, after.id);
  return `(s.cvss_score < $${values.length - 2} OR s.cvss_score IS NULL OR
    (s.cvss_score = $${values.length - 2} AND
      (s.group_first_seen_at < $${values.length - 1}::timestamptz OR
        (s.group_first_seen_at = $${values.length - 1}::timestamptz AND s.id > $${values.length}::uuid))))`;
}

const scoreOrder = "s.cvss_score DESC NULLS LAST, s.group_first_seen_at DESC, s.id";
const newestOrder = "s.group_first_seen_at DESC, s.id";

function findingSql(where: string[], order: string, limitParameter: number): string {
  return `WITH base AS (
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
         ), scored AS (
           SELECT l.*, sev.cvss_score, sev.cvss_version,
                  sev.source AS cvss_source, sev.source_id AS cvss_source_id
           FROM leads l
           LEFT JOIN LATERAL (
             SELECT a.cvss_score, a.cvss_version, a.source, a.source_id
             FROM vulnerabilities a
             WHERE (a.id = l.vulnerability_id OR a.id IN
               (SELECT vulnerability_id FROM vulnerability_group_members WHERE group_id = l.group_id))
               AND a.cvss_score IS NOT NULL
             ORDER BY a.cvss_score DESC, a.cvss_version DESC, a.source, a.source_id
             LIMIT 1
           ) sev ON true
         ), paged AS (
           SELECT s.* FROM scored s
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY ${order}
           LIMIT $${limitParameter}
         )
         SELECT p.id, p.purl, p.version, p.ecosystem, p.scope, p.status, p.resolved_reason, p.resolved_at,
                p.match_quality, p.match_reason, p.group_first_seen_at AS first_seen_at,
                p.group_last_seen_at AS last_seen_at, p.import_id, p.evidence, p.group_id,
                p.cvss_score, p.cvss_version, p.cvss_source, p.cvss_source_id,
                v.id AS vulnerability_id, v.source, v.source_id, v.aliases, v.summary, v.severity,
                src.sources, p.group_first_seen_at::text AS cursor_ts,
                CASE
                  WHEN NOT EXISTS (SELECT 1 FROM normalization_runs nr
                    WHERE nr.source = 'cisa-kev' AND nr.status IN ('completed', 'published')) THEN 'unavailable'
                  WHEN NOT EXISTS (
                    SELECT 1 FROM vulnerabilities a,
                      unnest(a.aliases || a.source_id) AS ids(identifier)
                    WHERE (a.id = p.vulnerability_id OR a.id IN
                      (SELECT vulnerability_id FROM vulnerability_group_members WHERE group_id = p.group_id))
                      AND identifier ~ '^CVE-[0-9]{4}-[0-9]{4,}$'
                  ) THEN 'unavailable'
                  WHEN EXISTS (
                    SELECT 1 FROM vulnerabilities a JOIN kev_entries k
                      ON k.removed_at IS NULL AND k.cve_id = ANY(a.aliases || a.source_id)
                    WHERE a.id = p.vulnerability_id OR a.id IN
                      (SELECT vulnerability_id FROM vulnerability_group_members WHERE group_id = p.group_id)
                  ) THEN 'listed' ELSE 'not_listed'
                END AS kev_status
         FROM paged p
         LEFT JOIN vulnerability_groups g ON g.id = p.group_id
         JOIN vulnerabilities v ON v.id = COALESCE(g.canonical_vulnerability_id, p.vulnerability_id)
         CROSS JOIN LATERAL (
           SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'source', a.source,
                    'sourceId', a.source_id, 'aliases', a.aliases) ORDER BY a.source, a.source_id), '[]') AS sources
           FROM vulnerabilities a
           WHERE a.id = p.vulnerability_id
              OR a.id IN (SELECT vulnerability_id FROM vulnerability_group_members WHERE group_id = p.group_id)
         ) src
         ORDER BY ${order.replaceAll("s.", "p.")}`;
}

/** Reads one item per dependency and vulnerability group; the correlator owns the underlying rows. */
export function createFindingStore(pool: Pool) {
  return {
    async list(tenant: TenantContext, slug: string, query: FindingQuery) {
      const projectId = await findProject(pool, tenant, slug);
      const after = decodeCursor(query);
      const values: unknown[] = [tenant.orgId, projectId];
      const where = pageConditions(query, after, values);
      values.push(query.limit + 1);
      const order = query.sort === "severity" ? scoreOrder : newestOrder;
      const { rows } = await pool.query<FindingRow>(
        findingSql(where, order, values.length),
        values,
      );
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toFinding),
        nextCursor: rows.length > query.limit && last ? encodeCursor(query, last) : null,
      };
    },
  };
}

export type FindingStore = ReturnType<typeof createFindingStore>;
