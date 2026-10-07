import type { Pool, PoolClient } from "pg";
import { AppError } from "@sentra/ts-platform";
import * as metrics from "./metrics.ts";
import { decodeCursor, encodeCursor } from "./org-input.ts";
import { inTransaction, type Role, type TenantContext } from "./orgs.ts";

interface Member {
  userId: string;
  name: string | null;
  role: Role;
  joinedAt: string;
  /** Present only when the caller is an admin of the org. */
  email?: string | null;
}

interface MemberRow {
  user_id: string;
  name: string | null;
  email: string | null;
  role: Role;
  created_at: Date;
}

const MEMBER_SELECT = `SELECT m.user_id, u.name, u.email, m.role, m.created_at
  FROM memberships m JOIN users u ON u.id = m.user_id`;

const toMember = (row: MemberRow, caller: TenantContext): Member => ({
  userId: row.user_id,
  name: row.name,
  role: row.role,
  joinedAt: row.created_at.toISOString(),
  ...(caller.role === "admin" ? { email: row.email } : {}),
});

const forbidden = () => {
  metrics.inc("role_denied_total");
  return new AppError("forbidden", 403, "Forbidden", { reason: "role_denied" });
};

const notFound = () => new AppError("not_found", 404, "Not found", { reason: "member_not_found" });

/**
 * Serializes every membership change in one org. NO KEY UPDATE conflicts with itself but not with
 * the foreign-key checks other rows run against this org, so it blocks only other changes.
 */
const lockOrg = (client: PoolClient, orgId: string) =>
  client.query("SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE", [orgId]);

/**
 * The caller's role was read before the lock was taken, so re-read it under the lock: an admin who
 * was demoted or removed in the meantime must not complete an admin-only change.
 */
async function assertStillAdmin(client: PoolClient, tenant: TenantContext) {
  const { rows } = await client.query<{ role: Role }>(
    "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2",
    [tenant.orgId, tenant.userId],
  );
  if (!rows[0])
    throw new AppError("not_found", 404, "Not found", { reason: "tenant_access_denied" });
  if (rows[0].role !== "admin") throw forbidden();
}

/** Runs after the change inside the transaction; zero admins left rolls the whole change back. */
async function assertAdminRemains(client: PoolClient, orgId: string) {
  const { rows } = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'admin'",
    [orgId],
  );
  if (rows[0]!.n === 0) {
    throw new AppError("last_admin", 409, "An organization needs at least one admin", {
      reason: "last_admin",
    });
  }
}

const recordAudit = (
  client: PoolClient,
  tenant: TenantContext,
  correlationId: string,
  action: string,
  targetUserId: string,
  metadata: Record<string, string>,
) =>
  client.query(
    `INSERT INTO audit_events (org_id, actor_user_id, action, target_type, target_id, correlation_id, metadata)
     VALUES ($1, $2, $3, 'user', $4, $5, $6)`,
    [tenant.orgId, tenant.userId, action, targetUserId, correlationId, metadata],
  );

function listMembers(pool: Pool) {
  return async (tenant: TenantContext, limit: number, cursor?: string) => {
    const after = cursor ? decodeCursor(cursor) : undefined;
    // The cursor's second field is a user ID here; `decodeCursor` only checks it is a UUID.
    const { rows } = await pool.query<MemberRow & { cursor_ts: string }>(
      `SELECT m.user_id, u.name, u.email, m.role, m.created_at, m.created_at::text AS cursor_ts
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1
         AND ($2::timestamptz IS NULL OR (m.created_at, m.user_id) > ($2::timestamptz, $3::uuid))
       ORDER BY m.created_at, m.user_id
       LIMIT $4`,
      [tenant.orgId, after?.createdAt ?? null, after?.orgId ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toMember(row, tenant)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.cursor_ts, last.user_id) : null,
    };
  };
}

async function loadMember(client: PoolClient, tenant: TenantContext, userId: string) {
  const { rows } = await client.query<MemberRow>(
    `${MEMBER_SELECT} WHERE m.org_id = $1 AND m.user_id = $2`,
    [tenant.orgId, userId],
  );
  return rows[0];
}

/** Admin only. Setting the role a member already has is a no-op: no write and no audit event. */
function setRole(pool: Pool) {
  return (tenant: TenantContext, userId: string, role: Role, correlationId: string) =>
    inTransaction(pool, async (client) => {
      await lockOrg(client, tenant.orgId);
      await assertStillAdmin(client, tenant);

      const current = await loadMember(client, tenant, userId);
      if (!current) throw notFound();
      if (current.role === role) return { member: toMember(current, tenant), changed: false };

      await client.query("UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2", [
        tenant.orgId,
        userId,
        role,
      ]);
      await assertAdminRemains(client, tenant.orgId);
      await recordAudit(client, tenant, correlationId, "member.role_changed", userId, {
        from: current.role,
        to: role,
      });
      return { member: toMember({ ...current, role }, tenant), changed: true };
    });
}

/**
 * Removes a member, or lets the caller leave when `userId` is their own. Admin-only unless leaving.
 * Deleting someone who is not a member succeeds without a write, so retries are harmless.
 */
function removeMember(pool: Pool) {
  return (tenant: TenantContext, userId: string, correlationId: string) =>
    inTransaction(pool, async (client) => {
      const leaving = userId === tenant.userId;
      await lockOrg(client, tenant.orgId);
      if (!leaving) await assertStillAdmin(client, tenant);

      const { rows } = await client.query<{ role: Role }>(
        "DELETE FROM memberships WHERE org_id = $1 AND user_id = $2 RETURNING role",
        [tenant.orgId, userId],
      );
      if (!rows[0]) return { removed: false, leaving };

      await assertAdminRemains(client, tenant.orgId);
      await recordAudit(
        client,
        tenant,
        correlationId,
        leaving ? "member.left" : "member.removed",
        userId,
        { role: rows[0].role },
      );
      return { removed: true, leaving };
    });
}

export function createMemberStore(pool: Pool) {
  return { list: listMembers(pool), setRole: setRole(pool), remove: removeMember(pool) };
}

export type MemberStore = ReturnType<typeof createMemberStore>;
