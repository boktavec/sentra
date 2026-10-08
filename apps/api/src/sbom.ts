import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AppError } from "@sentra/ts-platform";
import * as metrics from "./metrics.ts";
import { decodeCursor, encodeCursor } from "./org-input.ts";
import { recordAudit } from "./org-tx.ts";
import { inTransaction, type TenantContext } from "./orgs.ts";
import type { SbomStorage } from "./sbom-storage.ts";

export interface SbomLimits {
  maxBytes: number;
  uploadTtlSeconds: number;
  maxPendingPerProject: number;
}

interface SbomImport {
  id: string;
  filename: string;
  status: string;
  reasonCode: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ImportRow {
  id: string;
  filename: string;
  status: string;
  reason_code: string | null;
  size_bytes: string | null;
  sha256: string | null;
  object_key: string;
  project_id: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  "id, filename, status, reason_code, size_bytes, sha256, object_key, project_id, expires_at, created_at, updated_at";

const toImport = (row: ImportRow): SbomImport => ({
  id: row.id,
  filename: row.filename,
  status: row.status,
  reasonCode: row.reason_code,
  // bigint arrives as a string; an SBOM is capped far below Number.MAX_SAFE_INTEGER.
  sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  sha256: row.sha256,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const notFound = (reason: string) => new AppError("not_found", 404, "Not found", { reason });

const objectKey = (orgId: string, projectId: string, importId: string) =>
  `sbom/${orgId}/${projectId}/${importId}.json`;

/** Resolves the project inside the caller's org; a slug from another org is simply not found. */
async function findProject(db: Pick<Pool, "query">, tenant: TenantContext, slug: string) {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM projects WHERE org_id = $1 AND slug = $2",
    [tenant.orgId, slug],
  );
  if (!rows[0]) throw notFound("project_not_found");
  return rows[0].id;
}

async function findImport(
  db: Pick<Pool, "query">,
  tenant: TenantContext,
  projectId: string,
  id: string,
) {
  const { rows } = await db.query<ImportRow>(
    `SELECT ${COLUMNS} FROM sbom_imports WHERE id = $1 AND org_id = $2 AND project_id = $3`,
    [id, tenant.orgId, projectId],
  );
  if (!rows[0]) throw notFound("import_not_found");
  return rows[0];
}

/** Counts a status change; `reason` is only set for rejections. */
const transition = (to: string, reason = "none") =>
  metrics.inc("sbom_import_transitions_total", { to, reason });

export function createSbomStore(
  pool: Pool,
  deps: { storage: SbomStorage; limits: SbomLimits; topic?: string },
) {
  const { storage, limits } = deps;

  return {
    /**
     * Reserves an import and signs the one upload it may perform. The project row lock serializes
     * creates per project so the pending cap holds under parallel requests.
     */
    async create(
      tenant: TenantContext,
      slug: string,
      input: { filename: string; sizeBytes: number },
    ) {
      const projectId = await findProject(pool, tenant, slug);
      const row = await inTransaction(pool, async (client) => {
        await client.query("SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE", [projectId]);
        const pending = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM sbom_imports
           WHERE project_id = $1 AND status = 'pending_upload' AND expires_at > now()`,
          [projectId],
        );
        if (pending.rows[0]!.n >= limits.maxPendingPerProject) {
          throw new AppError("too_many_pending", 429, "Too many uploads in progress", {
            reason: "too_many_pending",
          });
        }
        const id = randomUUID();
        const { rows } = await client.query<ImportRow>(
          `INSERT INTO sbom_imports (id, org_id, project_id, created_by, filename, object_key, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
           RETURNING ${COLUMNS}`,
          [
            id,
            tenant.orgId,
            projectId,
            tenant.userId,
            input.filename,
            objectKey(tenant.orgId, projectId, id),
            limits.uploadTtlSeconds,
          ],
        );
        return rows[0]!;
      });
      transition("pending_upload");
      const upload = await storage.signUpload(
        row.object_key,
        limits.maxBytes,
        limits.uploadTtlSeconds,
      );
      return { ...toImport(row), expiresAt: row.expires_at.toISOString(), upload };
    },

    /**
     * Confirms the object landed, then moves the import to `uploaded` and queues `sbom.uploaded`
     * and the audit event in the same transaction. Repeating the call returns the current import.
     */
    async complete(tenant: TenantContext, slug: string, id: string, correlationId: string) {
      const projectId = await findProject(pool, tenant, slug);
      const current = await findImport(pool, tenant, projectId, id);
      if (current.status === "expired") {
        throw new AppError("expired", 409, "Upload expired", { reason: "expired" });
      }
      if (current.status !== "pending_upload") return toImport(current);
      if (current.expires_at.getTime() <= Date.now()) {
        throw new AppError("expired", 409, "Upload expired", { reason: "expired" });
      }

      const size = await storage.size(current.object_key);
      if (size === undefined) {
        throw new AppError("upload_missing", 409, "Upload not found", { reason: "upload_missing" });
      }
      if (size < 1 || size > limits.maxBytes) {
        await pool.query(
          `UPDATE sbom_imports SET status = 'rejected', reason_code = 'size', size_bytes = NULLIF($2, 0), updated_at = now()
           WHERE id = $1 AND status = 'pending_upload'`,
          [id, size],
        );
        transition("rejected", "size");
        throw new AppError("upload_invalid", 409, "Upload rejected", { reason: "upload_invalid" });
      }

      const row = await inTransaction(pool, async (client) => {
        const { rows } = await client.query<ImportRow>(
          `UPDATE sbom_imports SET status = 'uploaded', size_bytes = $2, updated_at = now()
           WHERE id = $1 AND org_id = $3 AND status = 'pending_upload'
           RETURNING ${COLUMNS}`,
          [id, size, tenant.orgId],
        );
        // Lost a race with a parallel complete: it did the work, so just report the state.
        if (!rows[0]) return undefined;
        await queueUploaded(client, tenant, rows[0], size, correlationId);
        await recordAudit(client, {
          orgId: tenant.orgId,
          actorUserId: tenant.userId,
          correlationId,
          action: "sbom.upload_completed",
          targetType: "sbom_import",
          targetId: id,
          metadata: { filename: rows[0].filename },
        });
        return rows[0];
      });
      if (!row) return toImport(await findImport(pool, tenant, projectId, id));
      transition("uploaded");
      return toImport(row);
    },

    async list(tenant: TenantContext, slug: string, limit: number, cursor?: string) {
      const projectId = await findProject(pool, tenant, slug);
      const after = cursor ? decodeCursor(cursor) : undefined;
      // The cursor's second field is an import ID here; `decodeCursor` only checks it is a UUID.
      const { rows } = await pool.query<ImportRow & { cursor_ts: string }>(
        `SELECT ${COLUMNS}, created_at::text AS cursor_ts FROM sbom_imports
         WHERE org_id = $1 AND project_id = $2
           AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
         ORDER BY created_at DESC, id DESC
         LIMIT $5`,
        [tenant.orgId, projectId, after?.createdAt ?? null, after?.orgId ?? null, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toImport),
        nextCursor: rows.length > limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
      };
    },

    async get(tenant: TenantContext, slug: string, id: string) {
      const projectId = await findProject(pool, tenant, slug);
      return toImport(await findImport(pool, tenant, projectId, id));
    },

    /**
     * Expires pending imports past their deadline and deletes any object a client managed to
     * upload to them. The delete comes first: if it fails the row stays pending and is retried.
     */
    async expirePending(batch = 100): Promise<number> {
      const { rows } = await pool.query<{ id: string; object_key: string }>(
        `SELECT id, object_key FROM sbom_imports
         WHERE status = 'pending_upload' AND expires_at <= now()
         ORDER BY expires_at LIMIT $1`,
        [batch],
      );
      const done: string[] = [];
      for (const row of rows) {
        await storage.remove(row.object_key);
        done.push(row.id);
      }
      if (done.length === 0) return 0;
      const expired = await pool.query(
        `UPDATE sbom_imports SET status = 'expired', updated_at = now()
         WHERE id = ANY($1::uuid[]) AND status = 'pending_upload' AND expires_at <= now()`,
        [done],
      );
      for (let i = 0; i < (expired.rowCount ?? 0); i++) transition("expired");
      return expired.rowCount ?? 0;
    },
  };

  /** The outbox row carries the whole event so the relay never needs to read anything else. */
  function queueUploaded(
    client: PoolClient,
    tenant: TenantContext,
    row: ImportRow,
    size: number,
    correlationId: string,
  ) {
    const eventId = randomUUID();
    const event = {
      eventId,
      type: "sbom.uploaded",
      version: 1,
      timestamp: new Date().toISOString(),
      correlationId,
      importId: row.id,
      orgId: tenant.orgId,
      projectId: row.project_id,
      artifact: { bucket: storage.bucket, key: row.object_key, sizeBytes: size },
    };
    return client.query(
      "INSERT INTO sbom_outbox (event_id, import_id, payload) VALUES ($1, $2, $3)",
      [eventId, row.id, event],
    );
  }
}

export type SbomStore = ReturnType<typeof createSbomStore>;
