import type { PoolClient } from "pg";
import { AppError } from "@sentra/ts-platform";
import * as metrics from "./metrics.ts";
import type { Role, TenantContext } from "./orgs.ts";

const forbidden = () => {
  metrics.inc("role_denied_total");
  return new AppError("forbidden", 403, "Forbidden", { reason: "role_denied" });
};

/**
 * Serializes every membership and invitation change in one org. NO KEY UPDATE conflicts with itself
 * but not with the foreign-key checks other rows run against this org, so it blocks only other changes.
 * Always take this lock before touching invitation or membership rows, so lock order never differs.
 */
export const lockOrg = (client: PoolClient, orgId: string) =>
  client.query("SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE", [orgId]);

/**
 * The caller's role was read before the lock was taken, so re-read it under the lock: an admin who
 * was demoted or removed in the meantime must not complete an admin-only change.
 */
export async function assertStillAdmin(client: PoolClient, tenant: TenantContext) {
  const { rows } = await client.query<{ role: Role }>(
    "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2",
    [tenant.orgId, tenant.userId],
  );
  if (!rows[0]) {
    throw new AppError("not_found", 404, "Not found", { reason: "tenant_access_denied" });
  }
  if (rows[0].role !== "admin") throw forbidden();
}

interface AuditEvent {
  orgId: string;
  actorUserId: string;
  correlationId: string;
  action: string;
  targetType: "user" | "invitation" | "project" | "sbom_import";
  targetId: string;
  metadata: Record<string, string>;
}

/** Runs inside the caller's transaction, so the event commits or rolls back with the change. */
export const recordAudit = (client: PoolClient, event: AuditEvent) =>
  client.query(
    `INSERT INTO audit_events (org_id, actor_user_id, action, target_type, target_id, correlation_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.orgId,
      event.actorUserId,
      event.action,
      event.targetType,
      event.targetId,
      event.correlationId,
      event.metadata,
    ],
  );
