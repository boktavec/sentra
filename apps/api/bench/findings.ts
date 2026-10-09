/** Repeatable first-page API benchmark. Creates and drops its own scratch database. */
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool } from "pg";
import { createLogger, unauthenticated } from "@sentra/ts-platform";
import { buildApp } from "../src/app.ts";
import { createFindingStore } from "../src/findings.ts";
import { createInvitationStore } from "../src/invitations.ts";
import { createMemberStore } from "../src/members.ts";
import { migrate } from "../src/migrate.ts";
import { createOrgStore } from "../src/orgs.ts";
import { createProjectStore } from "../src/projects.ts";
import { createUserStore } from "../src/users.ts";

const adminUrl = process.env["DATABASE_URL"];
if (!adminUrl) throw new Error("DATABASE_URL is required");
const scratch = `sentra15_bench_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const url = new URL(adminUrl);
url.pathname = `/${scratch}`;
const admin = new Pool({ connectionString: adminUrl });
let pool: Pool | undefined;
let app: ReturnType<typeof buildApp> | undefined;

function percentile(sorted: number[], p: number) {
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

try {
  await admin.query(`CREATE DATABASE ${scratch}`);
  pool = new Pool({ connectionString: url.toString(), max: 10 });
  await migrate(pool);
  const userStore = createUserStore(pool);
  const user = await userStore.resolve({ issuer: "bench", subject: "owner" });
  const org = (
    await pool.query<{ id: string }>(
      "INSERT INTO organizations (name, slug, created_by) VALUES ('Bench', 'bench', $1) RETURNING id",
      [user.id],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'admin')", [
    org,
    user.id,
  ]);
  const project = (
    await pool.query<{ id: string }>(
      "INSERT INTO projects (org_id, name, slug, created_by) VALUES ($1, 'Bench', 'bench', $2) RETURNING id",
      [org, user.id],
    )
  ).rows[0]!.id;
  const importId = (
    await pool.query<{ id: string }>(
      `INSERT INTO sbom_imports (org_id, project_id, created_by, filename, status, object_key, expires_at)
     VALUES ($1, $2, $3, 'bench.json', 'parsed', 'bench', now()) RETURNING id`,
      [org, project, user.id],
    )
  ).rows[0]!.id;
  const advisories: string[] = [];
  for (const [i, score] of [null, 3.1, 5.5, 7.5, 9.8].entries()) {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO vulnerabilities (source, source_id, aliases, modified_at, severity,
         cvss_score, cvss_version, cvss_calculated_at,
         source_artifact_sha256, source_entry, schema_version, adapter_version)
       VALUES ('osv', $1, ARRAY[$5], now(), '[]', $2, $3, now(), $4, 'bench', 1, 1) RETURNING id`,
      [`BENCH-${i}`, score, score === null ? null : "3.1", "a".repeat(64), `CVE-2026-${1000 + i}`],
    );
    const advisoryId = row.rows[0]!.id;
    advisories.push(advisoryId);
    const groupId = randomUUID();
    await pool.query(
      "INSERT INTO vulnerability_groups (id, canonical_vulnerability_id) VALUES ($1, $2)",
      [groupId, advisoryId],
    );
    await pool.query(
      "INSERT INTO vulnerability_group_members (vulnerability_id, group_id) VALUES ($1, $2)",
      [advisoryId, groupId],
    );
  }
  await pool.query(
    `INSERT INTO normalization_runs (artifact_sha256, source, ecosystem, adapter_version, status, correlation_id)
     VALUES ($1, 'cisa-kev', 'none', 1, 'published', 'bench')`,
    ["b".repeat(64)],
  );
  await pool.query(
    `INSERT INTO kev_entries (cve_id, date_added, content_hash, catalog_version,
       date_released, source_artifact_sha256, adapter_version)
     VALUES ('CVE-2026-1004', CURRENT_DATE, $1, 'bench', now(), $1, 1)`,
    ["c".repeat(64)],
  );
  await pool.query(
    `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope,
       import_id, match_quality, status, resolved_reason, resolved_at, matcher_version, evidence)
     SELECT $1, $2, (ARRAY[$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid])[1 + (g % 5)],
       'pkg:pypi/bench-' || g || '@1.0', '1.0', 'PyPI', 'required', $3, 'confirmed',
       CASE WHEN g % 7 = 0 THEN 'resolved' ELSE 'open' END,
       CASE WHEN g % 7 = 0 THEN 'dependency_removed' ELSE NULL END,
       CASE WHEN g % 7 = 0 THEN now() ELSE NULL END, 1, '{}'::jsonb
     FROM generate_series(1, 25000) AS g`,
    [org, project, importId, ...advisories],
  );
  await pool.query("ANALYZE findings");
  app = buildApp({
    logger: createLogger("bench", {
      level: "error",
      destination: new Writable({ write: (_c, _e, done) => done() }),
    }),
    orgs: createOrgStore(pool, { maxOrgsPerUser: 10 }),
    members: createMemberStore(pool),
    projects: createProjectStore(pool),
    findings: createFindingStore(pool),
    invitations: createInvitationStore(pool, {
      fetchProfile: async () => ({ emailVerified: false }),
      webUrl: "http://localhost:3000",
      limits: { ttlHours: 1, maxPending: 1, maxPerDay: 1, maxMembers: 1 },
    }),
    ready: async () => true,
    trustedProxies: false,
    authenticate: async (request) => {
      if (request.headers["x-test-user"] !== user.id) throw unauthenticated("missing_token");
      return user;
    },
  });
  const path = `/v1/orgs/${org}/projects/bench/findings`;
  const timings: number[] = [];
  for (let i = 0; i < 110; i++) {
    const start = performance.now();
    const response = await app.inject({
      method: "GET",
      url: path,
      headers: { "x-test-user": user.id },
    });
    if (response.statusCode !== 200 || response.json().items.length !== 50) {
      throw new Error(`request ${i} failed: ${response.statusCode}`);
    }
    if (i >= 10) timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      findings: 25000,
      requests: timings.length,
      concurrency: 1,
      p50Ms: percentile(timings, 50),
      p95Ms: percentile(timings, 95),
      p99Ms: percentile(timings, 99),
    }),
  );
} finally {
  await app?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  await admin.end();
}
