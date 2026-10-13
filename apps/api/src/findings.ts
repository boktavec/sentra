import type { Pool } from "pg";
import { AppError } from "@sentra/ts-platform";
import { isNumber, isString, type Json } from "./json.ts";
import { isUuid } from "./org-input.ts";
import type { TenantContext } from "./orgs.ts";
import { findProject } from "./projects.ts";
import {
  category,
  findingSql,
  toPriority,
  type FindingRow,
  type SeverityCategory,
} from "./finding-sql.ts";
import { getFindingDetail } from "./finding-detail.ts";

export type FindingStatus = "open" | "resolved" | "all";

export type Severity = SeverityCategory | "all";

export type FindingSort = "priority" | "severity" | "newest";

export type PriorityFilter = "all" | "p1" | "p2" | "p3" | "p4";

export interface FindingQuery {
  status: FindingStatus;
  severity: Severity;
  priority: PriorityFilter;
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
    priority: toPriority(row),
    sources: row.sources,
  };
};

interface Cursor {
  tier: number;
  score: number | null;
  time: string;
  id: string;
}

function decodeCursor(query: FindingQuery): Cursor | null {
  if (!query.cursor) return null;

  if (query.cursor.length > 1024) throw invalid("cursor");

  try {
    const parts: Json = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
    const position = cursorPosition(query, parts);

    if (position) return position;
  } catch {
    // Invalid or mismatched cursors use the ordinary input error.
  }

  throw invalid("cursor");
}

const isTier = (value: Json | undefined): value is number =>
  isNumber(value) && Number.isInteger(value) && value >= 1 && value <= 4;

const isCursorScore = (value: Json | undefined): value is number | null =>
  value === null || (isNumber(value) && value >= 0 && value <= 10);

/** The position encoded in `parts`, if it is a well-formed cursor issued for exactly this query. */
function cursorPosition(query: FindingQuery, parts: Json): Cursor | null {
  if (!Array.isArray(parts)) return null;
  const [sort, status, severity, priority, tier, score, time, id] = parts;

  if (!issuedForQuery(query, [sort, status, severity, priority])) return null;

  if (!isTier(tier) || !isCursorScore(score) || !isCursorTime(time) || !isCursorId(id)) return null;

  return { tier, score, time, id };
}

const issuedForQuery = (
  query: FindingQuery,
  [sort, status, severity, priority]: (Json | undefined)[],
) =>
  sort === query.sort &&
  status === query.status &&
  severity === query.severity &&
  priority === query.priority;

const isCursorTime = (value: Json | undefined): value is string =>
  isString(value) && timestamp.test(value);

const isCursorId = (value: Json | undefined): value is string => isString(value) && isUuid(value);

function encodeCursor(query: FindingQuery, row: FindingRow): string {
  return Buffer.from(
    JSON.stringify([
      query.sort,
      query.status,
      query.severity,
      query.priority,
      row.priority_tier,
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

  if (query.priority !== "all") {
    values.push(Number(query.priority.slice(1)));
    where.push(`s.priority_tier = $${values.length}`);
  }

  if (after) where.push(cursorCondition(query.sort, after, values));

  return where;
}

function cursorCondition(sort: FindingSort, after: Cursor, values: unknown[]): string {
  if (sort !== "priority") return afterInOrder(sort, after, values);
  values.push(after.tier);
  const tier = `$${values.length}`;

  return `(s.priority_tier > ${tier} OR (s.priority_tier = ${tier} AND ${afterInOrder(sort, after, values)}))`;
}

/** Keyset condition for the order after any tier: CVSS score (unless `newest`), then first seen, then id. */
function afterInOrder(sort: FindingSort, after: Cursor, values: unknown[]): string {
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

const priorityOrder = `s.priority_tier, s.cvss_score DESC NULLS LAST, s.group_first_seen_at DESC, s.id`;

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

      const order = { priority: priorityOrder, severity: scoreOrder, newest: newestOrder }[
        query.sort
      ];

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
