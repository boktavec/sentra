import type { Pool, PoolClient } from "pg";
import { AppError } from "@sentra/ts-platform";
import { decodeCursor, encodeCursor } from "./org-input.ts";
import { assertStillAdmin, lockOrg, recordAudit } from "./org-tx.ts";
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

const notFound = () => new AppError("not_found", 404, "Not found", { reason: "member_not_found" });

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
      await recordAudit(client, {
        orgId: tenant.orgId,
        actorUserId: tenant.userId,
        correlationId,
        action: "member.role_changed",
        targetType: "user",
        targetId: userId,
        metadata: { from: current.role, to: role },
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
      await recordAudit(client, {
        orgId: tenant.orgId,
        actorUserId: tenant.userId,
        correlationId,
        action: leaving ? "member.left" : "member.removed",
        targetType: "user",
        targetId: userId,
        metadata: { role: rows[0].role },
      });
      return { removed: true, leaving };
    });
}

export function createMemberStore(pool: Pool) {
  return { list: listMembers(pool), setRole: setRole(pool), remove: removeMember(pool) };
}

export type MemberStore = ReturnType<typeof createMemberStore>;
