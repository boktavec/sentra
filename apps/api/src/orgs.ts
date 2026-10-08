import type { Pool, PoolClient } from "pg";
import { AppError } from "@sentra/ts-platform";
import * as metrics from "./metrics.ts";
import { decodeCursor, encodeCursor, isUuid } from "./org-input.ts";

export type Role = "admin" | "member";

interface Org {
  id: string;
  name: string;
  slug: string;
  role: Role;
  createdAt: string;
}

/** Built only by the membership check; org-scoped domain functions take this, never a raw orgId. */
export interface TenantContext {
  orgId: string;
  userId: string;
  role: Role;
}

interface NewOrg {
  name: string;
  slug: string;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  role: Role;
  created_at: Date;
}

const ORG_COLUMNS = "o.id, o.name, o.slug, m.role, o.created_at";

const toOrg = (row: OrgRow): Org => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  role: row.role,
  createdAt: row.created_at.toISOString(),
});

export async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function insertOrg(client: PoolClient, userId: string, input: NewOrg) {
  const { rows } = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO organizations (name, slug, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO NOTHING RETURNING id, created_at`,
    [input.name, input.slug, userId],
  );
  return rows[0];
}

/** A slug conflict where the caller is already admin of a same-named org is a retry. */
async function findRetry(client: PoolClient, userId: string, input: NewOrg) {
  const { rows } = await client.query<OrgRow>(
    `SELECT ${ORG_COLUMNS} FROM organizations o
     JOIN memberships m ON m.org_id = o.id AND m.user_id = $2 AND m.role = 'admin'
     WHERE o.slug = $1 AND o.name = $3`,
    [input.slug, userId, input.name],
  );
  return rows[0] ? toOrg(rows[0]) : undefined;
}

/** Counted after the insert, so a retry at the cap still reaches the idempotent path. */
async function enforceCap(client: PoolClient, userId: string, max: number) {
  const { rows } = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM memberships WHERE user_id = $1 AND role = 'admin'",
    [userId],
  );
  if (rows[0]!.n > max) {
    throw new AppError("org_limit_reached", 403, "Organization limit reached", { reason: "limit" });
  }
}

const addAdmin = (client: PoolClient, userId: string, orgId: string) =>
  client.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'admin')", [
    orgId,
    userId,
  ]);

const recordCreated = (client: PoolClient, userId: string, orgId: string, correlationId: string) =>
  client.query(
    `INSERT INTO audit_events (org_id, actor_user_id, action, target_type, target_id, correlation_id)
     VALUES ($1, $2, 'org.created', 'organization', $1, $3)`,
    [orgId, userId, correlationId],
  );

/**
 * Creates the org, the admin membership and the audit event in one transaction. The user row lock
 * serializes one user's creates so parallel requests cannot pass the cap.
 */
function createOrg(pool: Pool, maxOrgsPerUser: number) {
  return (userId: string, input: NewOrg, correlationId: string) =>
    inTransaction(pool, async (client) => {
      await client.query("SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [userId]);

      const inserted = await insertOrg(client, userId, input);
      if (!inserted) {
        const existing = await findRetry(client, userId, input);
        if (existing) return { org: existing, created: false };
        throw new AppError("slug_taken", 409, "Slug already in use", { reason: "slug_taken" });
      }

      await addAdmin(client, userId, inserted.id);
      await enforceCap(client, userId, maxOrgsPerUser);
      await recordCreated(client, userId, inserted.id, correlationId);
      const org: Org = {
        ...input,
        id: inserted.id,
        role: "admin",
        createdAt: inserted.created_at.toISOString(),
      };
      return { org, created: true };
    });
}

function listOrgs(pool: Pool) {
  return async (userId: string, limit: number, cursor?: string) => {
    const after = cursor ? decodeCursor(cursor) : undefined;
    const { rows } = await pool.query<OrgRow & { cursor_ts: string }>(
      `SELECT ${ORG_COLUMNS}, m.created_at::text AS cursor_ts
       FROM memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = $1
         AND ($2::timestamptz IS NULL OR (m.created_at, m.org_id) > ($2::timestamptz, $3::uuid))
       ORDER BY m.created_at, m.org_id
       LIMIT $4`,
      [userId, after?.createdAt ?? null, after?.orgId ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toOrg),
      nextCursor: rows.length > limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
    };
  };
}

function denied(): AppError {
  metrics.inc("tenant_access_denied_total");
  return new AppError("not_found", 404, "Not found", { reason: "tenant_access_denied" });
}

/**
 * The one membership check. Missing org, malformed ID, unknown slug and non-membership are all
 * the same 404 so callers cannot tell which orgs exist.
 */
function resolveTenant(pool: Pool) {
  return async (
    userId: string,
    by: { orgId: string } | { slug: string },
  ): Promise<{ tenant: TenantContext; org: Org }> => {
    const [column, value] =
      "orgId" in by ? (["id", by.orgId] as const) : (["slug", by.slug] as const);
    if (column === "id" && !isUuid(value)) throw denied();
    const { rows } = await pool.query<OrgRow>(
      `SELECT ${ORG_COLUMNS} FROM organizations o
       JOIN memberships m ON m.org_id = o.id AND m.user_id = $2
       WHERE o.${column} = $1`,
      [value, userId],
    );
    if (!rows[0]) throw denied();
    return { tenant: { orgId: rows[0].id, userId, role: rows[0].role }, org: toOrg(rows[0]) };
  };
}

export function createOrgStore(pool: Pool, options: { maxOrgsPerUser: number }) {
  return {
    create: createOrg(pool, options.maxOrgsPerUser),
    list: listOrgs(pool),
    resolveTenant: resolveTenant(pool),
  };
}

export type OrgStore = ReturnType<typeof createOrgStore>;
