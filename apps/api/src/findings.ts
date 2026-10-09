import type { Pool } from "pg";
import { AppError } from "@sentra/ts-platform";
import { isUuid } from "./org-input.ts";
import type { TenantContext } from "./orgs.ts";
import { findProject } from "./projects.ts";
import { category, findingSql, type FindingRow, type SeverityCategory } from "./finding-sql.ts";
import { getFindingDetail } from "./finding-detail.ts";

export type FindingStatus = "open" | "resolved" | "all";
export type Severity = SeverityCategory | "all";
export type FindingSort = "severity" | "newest";
export interface FindingQuery {
  status: FindingStatus;
  severity: Severity;
  sort: FindingSort;
  limit: number;
  cursor?: string;
}

const invalid = (reason: string) => new AppError("invalid_input", 400, "Invalid input", { reason });
const timestamp = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/;

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

/** Reads one item per dependency and vulnerability group; the correlator owns the underlying rows. */
export function createFindingStore(pool: Pool) {
  return {
    get: getFindingDetail.bind(null, pool),
    async list(tenant: TenantContext, slug: string, query: FindingQuery) {
      const projectId = await findProject(pool, tenant, slug);
      const after = decodeCursor(query);
      const values: unknown[] = [tenant.orgId, projectId];
      const where = pageConditions(query, after, values);
      values.push(query.limit + 1);
      const order = query.sort === "severity" ? scoreOrder : newestOrder;
      const { rows } = await pool.query<FindingRow>(
        findingSql({
          baseWhere: "f.org_id = $1 AND f.project_id = $2",
          where,
          order,
          limit: `$${values.length}`,
        }),
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
