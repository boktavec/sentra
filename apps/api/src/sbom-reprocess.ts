import { randomUUID } from "node:crypto";
import { Pool } from "pg";

/** Statuses a finished import can be replayed from. Anything still in flight is left alone. */
const REPLAYABLE = ["validated", "parsed", "rejected"];

/**
 * Operator replay: put a finished import back to `uploaded` and queue a fresh `sbom.uploaded`, so the
 * pipeline parses the stored raw object again. No re-upload. One transaction, so a crash leaves
 * either the old result or a queued replay, never a half state. Returns false when the import is
 * unknown or not in a replayable status.
 */
export async function reprocess(pool: Pool, importId: string, bucket: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT org_id, project_id, object_key, size_bytes, status FROM sbom_imports WHERE id = $1 FOR UPDATE",
      [importId],
    );
    const row = rows[0];
    if (!row || !REPLAYABLE.includes(row.status)) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("DELETE FROM sbom_dependencies WHERE import_id = $1", [importId]);
    await client.query(
      `UPDATE sbom_imports SET status = 'uploaded', reason_code = NULL, dependency_count = NULL,
         skipped_count = NULL, updated_at = now() WHERE id = $1`,
      [importId],
    );
    const eventId = randomUUID();
    const event = {
      eventId,
      type: "sbom.uploaded",
      version: 1,
      timestamp: new Date().toISOString(),
      correlationId: `reprocess-${eventId}`,
      importId,
      orgId: row.org_id,
      projectId: row.project_id,
      artifact: { bucket, key: row.object_key, sizeBytes: Number(row.size_bytes ?? 1) },
    };
    await client.query(
      "INSERT INTO sbom_outbox (event_id, import_id, payload) VALUES ($1, $2, $3)",
      [eventId, importId, event],
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (import.meta.main) {
  const importId = process.argv[2];
  if (!importId) {
    console.error("usage: sbom-reprocess.ts <import-id>");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  const queued = await reprocess(pool, importId, process.env["S3_BUCKET"] ?? "sentra-raw");
  await pool.end();
  console.log(queued ? `queued ${importId}` : `${importId} not found or not replayable`);
  process.exit(queued ? 0 : 1);
}
