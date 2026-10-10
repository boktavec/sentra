import type { Pool } from "pg";
import { AppError, type Logger } from "@sentra/ts-platform";
import { isUuid } from "./org-input.ts";
import type { TenantContext } from "./orgs.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_CURSOR_LENGTH = 2048;
const MAX_ACTION_LENGTH = 100;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

type Result = "success" | "failed";
type TargetType =
  "organization" | "user" | "invitation" | "project" | "sbom_import" | "investigation";

interface AuditItem {
  id: string;
  orgId: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: Date;
  result: Result;
  failureCode: string | null;
  correlationId: string | null;
}

interface Query {
  from?: string;
  to?: string;
  actorId?: string;
  action?: string;
  result?: Result;
  limit: number;
  cursor?: string;
}

interface Cursor {
  filters: Omit<Query, "cursor">;
  createdAt: string;
  id: string;
}

export interface AuditStore {
  list(
    tenant: TenantContext,
    raw: Record<string, unknown>,
  ): Promise<{ items: AuditItem[]; nextCursor: string | null }>;
  recordFailure(event: {
    tenant: TenantContext;
    action: string;
    targetType: TargetType;
    correlationId: string;
    failureCode: string;
  }): Promise<void>;
}

const invalid = (reason: string) => new AppError("invalid_input", 400, "Invalid input", { reason });
const optional = (value: unknown, name: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(name);
  return value;
};

function utc(value: string | undefined, name: string) {
  if (value === undefined) return undefined;
  if (!ISO_UTC.test(value) || Number.isNaN(Date.parse(value))) throw invalid(name);
  return { value, milliseconds: Date.parse(value) };
}

function dateRange(raw: Record<string, unknown>) {
  const from = utc(optional(raw.from, "from"), "from");
  const to = utc(optional(raw.to, "to"), "to");
  if (from && to && from.milliseconds >= to.milliseconds) throw invalid("date_range");
  return { from: from?.value, to: to?.value };
}

function actor(raw: Record<string, unknown>) {
  const actorId = optional(raw.actorId, "actorId");
  if (actorId !== undefined && !isUuid(actorId)) throw invalid("actorId");
  return actorId;
}

function action(raw: Record<string, unknown>) {
  const value = optional(raw.action, "action");
  if (value !== undefined && (value.length === 0 || value.length > MAX_ACTION_LENGTH)) {
    throw invalid("action");
  }
  return value;
}

function result(raw: Record<string, unknown>) {
  const value = optional(raw.result, "result");
  if (value !== undefined && value !== "success" && value !== "failed") throw invalid("result");
  return value;
}

function limit(raw: Record<string, unknown>) {
  const value = optional(raw.limit, "limit");
  const parsed = value === undefined ? DEFAULT_LIMIT : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) throw invalid("limit");
  return parsed;
}

function cursor(raw: Record<string, unknown>) {
  const value = optional(raw.cursor, "cursor");
  if (value && value.length > MAX_CURSOR_LENGTH) throw invalid("cursor");
  return value;
}

function parseQuery(raw: Record<string, unknown>): Query {
  return {
    ...dateRange(raw),
    actorId: actor(raw),
    action: action(raw),
    result: result(raw),
    limit: limit(raw),
    cursor: cursor(raw),
  };
}

function filters(query: Query): Omit<Query, "cursor"> {
  return {
    from: query.from,
    to: query.to,
    actorId: query.actorId,
    action: query.action,
    result: query.result,
    limit: query.limit,
  };
}

function decodeCursor(query: Query): Pick<Cursor, "createdAt" | "id"> | undefined {
  if (!query.cursor) return undefined;
  try {
    const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as Cursor;
    if (
      JSON.stringify(cursor.filters) === JSON.stringify(filters(query)) &&
      typeof cursor.createdAt === "string" &&
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?\+00$/.test(cursor.createdAt) &&
      typeof cursor.id === "string" &&
      isUuid(cursor.id)
    ) {
      return cursor;
    }
  } catch {
    // Deliberately return one generic input error for malformed and mismatched cursors.
  }
  throw invalid("cursor");
}

function encodeCursor(query: Query, row: AuditItem & { cursorTs: string }) {
  return Buffer.from(
    JSON.stringify({
      filters: filters(query),
      createdAt: row.cursorTs,
      id: row.id,
    } satisfies Cursor),
  ).toString("base64url");
}

export function createAuditStore(pool: Pool, logger: Logger): AuditStore {
  return {
    async list(tenant, raw) {
      const query = parseQuery(raw);
      const after = decodeCursor(query);
      const values: unknown[] = [tenant.orgId];
      const where = ["org_id = $1"];
      const add = (condition: string, value: unknown) => {
        values.push(value);
        where.push(condition.replace("?", `$${values.length}`));
      };
      if (query.from) add("created_at >= ?::timestamptz", query.from);
      if (query.to) add("created_at < ?::timestamptz", query.to);
      if (query.actorId) add("actor_user_id = ?::uuid", query.actorId);
      if (query.action) add("action = ?", query.action);
      if (query.result) add("result = ?", query.result);
      if (after) {
        values.push(after.createdAt, after.id);
        where.push(
          `(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
        );
      }
      values.push(query.limit + 1);
      const { rows } = await pool.query<{
        id: string;
        org_id: string;
        actor_user_id: string;
        action: string;
        target_type: string;
        target_id: string | null;
        created_at: Date;
        cursor_ts: string;
        result: Result;
        failure_code: string | null;
        correlation_id: string | null;
      }>(
        `SELECT id, org_id, actor_user_id, action, target_type, target_id, created_at,
                created_at::text AS cursor_ts, result, failure_code, correlation_id
         FROM audit_events WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      const page = rows.slice(0, query.limit).map((row) => ({
        id: row.id,
        orgId: row.org_id,
        actorUserId: row.actor_user_id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        createdAt: row.created_at,
        result: row.result,
        failureCode: row.failure_code,
        correlationId: row.correlation_id,
        cursorTs: row.cursor_ts,
      }));
      const last = page.at(-1);
      return {
        items: page.map((item) => ({
          id: item.id,
          orgId: item.orgId,
          actorUserId: item.actorUserId,
          action: item.action,
          targetType: item.targetType,
          targetId: item.targetId,
          createdAt: item.createdAt,
          result: item.result,
          failureCode: item.failureCode,
          correlationId: item.correlationId,
        })),
        nextCursor: rows.length > query.limit && last ? encodeCursor(query, last) : null,
      };
    },

    async recordFailure({ tenant, action, targetType, correlationId, failureCode }) {
      try {
        await pool.query(
          `INSERT INTO audit_events
             (org_id, actor_user_id, action, target_type, target_id, correlation_id, result, failure_code)
           VALUES ($1, $2, $3, $4, NULL, $5, 'failed', $6)`,
          [tenant.orgId, tenant.userId, action, targetType, correlationId, failureCode],
        );
      } catch {
        logger.error(
          { correlationId, orgId: tenant.orgId, action },
          "tenant_audit_failure_recording_failed",
        );
      }
    },
  };
}
