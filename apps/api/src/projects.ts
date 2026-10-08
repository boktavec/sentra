import type { Pool } from "pg";
import { AppError } from "@sentra/ts-platform";
import { decodeCursor, encodeCursor } from "./org-input.ts";
import { recordAudit } from "./org-tx.ts";
import { inTransaction, type TenantContext } from "./orgs.ts";

interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  createdAt: string;
}

interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  created_at: Date;
}

const COLUMNS = "id, org_id, name, slug, created_at";

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  orgId: row.org_id,
  name: row.name,
  slug: row.slug,
  createdAt: row.created_at.toISOString(),
});

/**
 * Inserts the project and its audit event in one transaction. A slug conflict with the same name
 * is a retry and returns the existing project without a second audit event; any other conflict is
 * a 409. Parallel creates of one slug serialize on the unique index.
 */
function createProject(pool: Pool) {
  return (tenant: TenantContext, input: { name: string; slug: string }, correlationId: string) =>
    inTransaction(pool, async (client) => {
      const inserted = await client.query<ProjectRow>(
        `INSERT INTO projects (org_id, name, slug, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, slug) DO NOTHING RETURNING ${COLUMNS}`,
        [tenant.orgId, input.name, input.slug, tenant.userId],
      );
      if (inserted.rows[0]) {
        const project = toProject(inserted.rows[0]);
        await recordAudit(client, {
          orgId: tenant.orgId,
          actorUserId: tenant.userId,
          correlationId,
          action: "project.created",
          targetType: "project",
          targetId: project.id,
          metadata: { slug: project.slug },
        });
        return { project, created: true };
      }
      const existing = await client.query<ProjectRow>(
        `SELECT ${COLUMNS} FROM projects WHERE org_id = $1 AND slug = $2 AND name = $3`,
        [tenant.orgId, input.slug, input.name],
      );
      if (existing.rows[0]) return { project: toProject(existing.rows[0]), created: false };
      throw new AppError("slug_taken", 409, "Slug already in use", { reason: "slug_taken" });
    });
}

function listProjects(pool: Pool) {
  return async (tenant: TenantContext, limit: number, cursor?: string) => {
    const after = cursor ? decodeCursor(cursor) : undefined;
    // The cursor's second field is a project ID here; `decodeCursor` only checks it is a UUID.
    const { rows } = await pool.query<ProjectRow & { cursor_ts: string }>(
      `SELECT ${COLUMNS}, created_at::text AS cursor_ts FROM projects
       WHERE org_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
       ORDER BY created_at, id
       LIMIT $4`,
      [tenant.orgId, after?.createdAt ?? null, after?.orgId ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toProject),
      nextCursor: rows.length > limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
    };
  };
}

function getBySlug(pool: Pool) {
  return async (tenant: TenantContext, slug: string) => {
    const { rows } = await pool.query<ProjectRow>(
      `SELECT ${COLUMNS} FROM projects WHERE org_id = $1 AND slug = $2`,
      [tenant.orgId, slug],
    );
    if (!rows[0])
      throw new AppError("not_found", 404, "Not found", { reason: "project_not_found" });
    return toProject(rows[0]);
  };
}

export function createProjectStore(pool: Pool) {
  return { create: createProject(pool), list: listProjects(pool), getBySlug: getBySlug(pool) };
}

export type ProjectStore = ReturnType<typeof createProjectStore>;
