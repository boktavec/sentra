import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { AppError } from "@sentra/ts-platform";
import { decodeCursor, isUuid, toPage } from "./org-input.ts";
import { recordAudit } from "./org-tx.ts";
import { inTransaction, type TenantContext } from "./orgs.ts";
import { findProject } from "./projects.ts";

const missing = () =>
  new AppError("not_found", 404, "Not found", { reason: "investigation_not_found" });

interface FindingContext {
  id: string;
  org_id: string;
  project_id: string;
  purl: string;
  version: string;
  ecosystem: string;
  scope: string;
  status: string;
  match_quality: string;
  match_reason: string | null;
  evidence: unknown;
  source: string;
  source_id: string;
  aliases: string[];
  summary: string | null;
  severity: unknown;
}

interface RunRow {
  id: string;
  finding_id: string;
  status: "queued" | "running" | "completed" | "failed";
  failure_code: string | null;
  attempts: number;
  model_id: string;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  cursor_ts: string;
}

const FIELDS = `id, finding_id, status, failure_code, attempts, model_id, created_by,
  created_at, started_at, completed_at, created_at::text AS cursor_ts`;

const toRun = (r: RunRow) => ({
  id: r.id,
  findingId: r.finding_id,
  status: r.status,
  failureCode: r.failure_code,
  attempts: r.attempts,
  modelId: r.model_id,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  startedAt: r.started_at?.toISOString() ?? null,
  completedAt: r.completed_at?.toISOString() ?? null,
});

export function createInvestigationStore(
  pool: Pool,
  options: { modelId: string; maxPendingPerOrg: number },
) {
  async function scoped(tenant: TenantContext, slug: string, findingId: string) {
    if (!isUuid(findingId)) throw missing();
    return { projectId: await findProject(pool, tenant, slug), findingId };
  }

  return {
    async start(tenant: TenantContext, slug: string, findingId: string, correlationId: string) {
      const { projectId } = await scoped(tenant, slug, findingId);
      return inTransaction(pool, async (db) => {
        // Serializes the pending cap and active-run check for this org across API replicas.
        await db.query("SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE", [
          tenant.orgId,
        ]);
        const { rows: findings } = await db.query<FindingContext>(
          `SELECT f.id, f.org_id, f.project_id, f.purl, f.version, f.ecosystem, f.scope,
                  f.status, f.match_quality, f.match_reason, f.evidence,
                  v.source, v.source_id, v.aliases, v.summary, v.severity
           FROM findings f JOIN vulnerabilities v ON v.id = f.vulnerability_id
           WHERE f.id = $1 AND f.org_id = $2 AND f.project_id = $3
           FOR SHARE OF f`,
          [findingId, tenant.orgId, projectId],
        );
        const finding = findings[0];
        if (!finding) throw missing();
        if (finding.status !== "open") {
          throw new AppError("finding_resolved", 409, "Finding is resolved", {
            reason: "finding_resolved",
          });
        }
        const active = await db.query<RunRow>(
          `SELECT ${FIELDS} FROM investigations WHERE finding_id = $1 AND status IN ('queued', 'running')`,
          [findingId],
        );
        if (active.rows[0]) return { run: toRun(active.rows[0]), created: false };
        const pending = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM investigations WHERE org_id = $1 AND status IN ('queued', 'running')",
          [tenant.orgId],
        );
        if (pending.rows[0]!.n >= options.maxPendingPerOrg) {
          throw new AppError("investigation_limit", 429, "Too many investigations in progress", {
            reason: "investigation_limit",
          });
        }
        const snapshot = {
          version: 1,
          finding: {
            purl: finding.purl,
            version: finding.version,
            ecosystem: finding.ecosystem,
            scope: finding.scope,
            matchQuality: finding.match_quality,
            matchReason: finding.match_reason,
            evidence: finding.evidence,
          },
          advisory: {
            source: finding.source,
            sourceId: finding.source_id,
            aliases: finding.aliases,
            summary: finding.summary,
            severity: finding.severity,
          },
        };
        if (Buffer.byteLength(JSON.stringify(snapshot)) > 64 * 1024) {
          throw new AppError("context_too_large", 422, "Finding context is too large", {
            reason: "context_too_large",
          });
        }
        const id = randomUUID();
        const eventId = randomUUID();
        const { rows } = await db.query<RunRow>(
          `INSERT INTO investigations (id, org_id, project_id, finding_id, created_by, context_snapshot, model_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${FIELDS}`,
          [id, tenant.orgId, projectId, findingId, tenant.userId, snapshot, options.modelId],
        );
        await db.query(
          "INSERT INTO investigation_outbox (event_id, investigation_id, payload) VALUES ($1, $2, $3)",
          [
            eventId,
            id,
            {
              eventId,
              type: "investigation.requested",
              version: 1,
              timestamp: new Date().toISOString(),
              correlationId,
              investigationId: id,
              orgId: tenant.orgId,
              projectId,
            },
          ],
        );
        await recordAudit(db, {
          orgId: tenant.orgId,
          actorUserId: tenant.userId,
          action: "investigation.created",
          targetType: "investigation",
          targetId: id,
          correlationId,
          metadata: { findingId },
        });
        return { run: toRun(rows[0]!), created: true };
      });
    },

    async list(
      tenant: TenantContext,
      slug: string,
      findingId: string,
      limit: number,
      cursor?: string,
    ) {
      const { projectId } = await scoped(tenant, slug, findingId);
      const finding = await pool.query(
        "SELECT 1 FROM findings WHERE id = $1 AND org_id = $2 AND project_id = $3",
        [findingId, tenant.orgId, projectId],
      );
      if (!finding.rowCount) throw missing();
      const after = cursor ? decodeCursor(cursor) : undefined;
      const { rows } = await pool.query<RunRow>(
        `SELECT ${FIELDS} FROM investigations WHERE org_id = $1 AND project_id = $2 AND finding_id = $3
         AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $6`,
        [
          tenant.orgId,
          projectId,
          findingId,
          after?.createdAt ?? null,
          after?.orgId ?? null,
          limit + 1,
        ],
      );
      return toPage(rows, limit, toRun);
    },

    async get(tenant: TenantContext, slug: string, findingId: string, id: string) {
      const { projectId } = await scoped(tenant, slug, findingId);
      if (!isUuid(id)) throw missing();
      const { rows } = await pool.query<RunRow>(
        `SELECT ${FIELDS} FROM investigations
         WHERE id = $1 AND org_id = $2 AND project_id = $3 AND finding_id = $4`,
        [id, tenant.orgId, projectId, findingId],
      );
      if (!rows[0]) throw missing();
      return toRun(rows[0]);
    },
  };
}

export type InvestigationStore = ReturnType<typeof createInvestigationStore>;
