import { readdirSync, readFileSync } from "node:fs";
import { Pool } from "pg";

/** Applies migrations/*.sql in name order, each once, tracked in schema_migrations. */
export async function migrate(pool: Pool, dir = new URL("../migrations/", import.meta.url)) {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Advisory lock so concurrent API starts don't race on the same migration.
      await client.query("SELECT pg_advisory_xact_lock(727274)");
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (done.rowCount === 0) {
        await client.query(readFileSync(new URL(file, dir), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

if (import.meta.main) {
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  await migrate(pool);
  await pool.end();
  console.log("migrations applied");
}
