/** Repeatable first-page API benchmark. Creates and drops its own scratch database. */
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool } from "pg";
import { createLogger, unauthenticated } from "@sentra/ts-platform";
import { buildApp } from "../src/app.ts";
import { findingSql } from "../src/finding-sql.ts";
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

interface ListBody {
  items: unknown[];
}
interface DetailBody {
  members: unknown[];
  membersTruncated: boolean;
}

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
  // A representative global corpus: findings use 5,000 advisories in two-member groups, a 100,000-row
  // filler of unrelated advisories sits beside them, and the KEV catalog lists 1,000 CVEs. A per-item
  // sequential scan of `vulnerabilities` would show up here; five advisories would hide it.
  await pool.query(
    `INSERT INTO vulnerabilities (source, source_id, aliases, modified_at, severity,
       cvss_score, cvss_version, cvss_calculated_at,
       source_artifact_sha256, source_entry, schema_version, adapter_version)
     SELECT 'osv', 'BENCH-' || n, ARRAY['CVE-2026-' || (100000 + n)], now(), '[]',
       (ARRAY[NULL, 3.1, 5.5, 7.5, 9.8])[1 + (n % 5)],
       CASE WHEN n % 5 = 0 THEN NULL ELSE '3.1' END,
       now(), $1, 'bench', 1, 1
     FROM generate_series(1, 5000) n`,
    ["a".repeat(64)],
  );
  await pool.query(
    `INSERT INTO vulnerabilities (source, source_id, aliases, modified_at, severity,
       cvss_score, cvss_version, cvss_calculated_at,
       source_artifact_sha256, source_entry, schema_version, adapter_version)
     SELECT 'osv', 'FILL-' || n, ARRAY['CVE-2025-' || n], now(), '[]',
       round((random() * 10)::numeric, 1), '3.1', now(), $1, 'bench', 1, 1
     FROM generate_series(1, 100000) n`,
    ["a".repeat(64)],
  );
  await pool.query(
    `WITH ordered AS (
       SELECT id, row_number() OVER (ORDER BY source_id) AS rn FROM vulnerabilities
       WHERE source_id LIKE 'BENCH-%'
     ), pairs AS (
       SELECT (rn + 1) / 2 AS pair, gen_random_uuid() AS gid, (array_agg(id ORDER BY rn))[1] AS canonical
       FROM ordered GROUP BY (rn + 1) / 2
     ), made AS (
       INSERT INTO vulnerability_groups (id, canonical_vulnerability_id)
       SELECT gid, canonical FROM pairs RETURNING id
     )
     INSERT INTO vulnerability_group_members (vulnerability_id, group_id)
     SELECT o.id, p.gid FROM ordered o JOIN pairs p ON p.pair = (o.rn + 1) / 2
     WHERE EXISTS (SELECT 1 FROM made)`,
  );
  await pool.query(
    `INSERT INTO normalization_runs (artifact_sha256, source, ecosystem, adapter_version, status, correlation_id)
     VALUES ($1, 'cisa-kev', 'none', 1, 'published', 'bench')`,
    ["b".repeat(64)],
  );
  await pool.query(
    `INSERT INTO kev_entries (cve_id, date_added, content_hash, catalog_version,
       date_released, source_artifact_sha256, adapter_version)
     SELECT 'CVE-2026-' || (100000 + n * 5 + 1), CURRENT_DATE, $1, 'bench', now(), $1, 1
     FROM generate_series(1, 1000) n`,
    ["c".repeat(64)],
  );
  await pool.query(
    `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope,
       import_id, match_quality, status, resolved_reason, resolved_at, matcher_version, evidence)
     SELECT $1, $2, ids[1 + (g % 5000)],
       'pkg:pypi/bench-' || g || '@1.0', '1.0', 'PyPI', (ARRAY['required','optional','excluded'])[1 + (g % 3)], $3, 'confirmed',
       CASE WHEN g % 7 = 0 THEN 'resolved' ELSE 'open' END,
       CASE WHEN g % 7 = 0 THEN 'dependency_removed' ELSE NULL END,
       CASE WHEN g % 7 = 0 THEN now() ELSE NULL END, 1, '{}'::jsonb
     FROM generate_series(1, 25000) AS g,
       (SELECT array_agg(id ORDER BY source_id) AS ids FROM vulnerabilities WHERE source_id LIKE 'BENCH-%') a`,
    [org, project, importId],
  );
  await pool.query(
    "ANALYZE findings, vulnerabilities, vulnerability_groups, vulnerability_group_members, kev_entries",
  );
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
  const timeRequest = async (
    name: string,
    url: string,
    valid: (body: ListBody & DetailBody) => boolean,
  ) => {
    const start = performance.now();
    const response = await app!.inject({
      method: "GET",
      url,
      headers: { "x-test-user": user.id },
    });
    if (response.statusCode !== 200 || !valid(response.json())) {
      throw new Error(`${name} request failed: ${response.statusCode}`);
    }
    return performance.now() - start;
  };
  const measure = async (
    name: string,
    count: number,
    url: string,
    valid: (body: ListBody & DetailBody) => boolean,
  ) => {
    const timings: number[] = [];
    for (let i = 0; i < 110; i++) {
      const elapsed = await timeRequest(name, url, valid);
      if (i >= 10) timings.push(elapsed);
    }
    timings.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        scenario: name,
        findings: count,
        requests: timings.length,
        concurrency: 1,
        p50Ms: percentile(timings, 50),
        p95Ms: percentile(timings, 95),
        p99Ms: percentile(timings, 99),
      }),
    );
  };
  // SENTRA-14: a fifth of the findings are KEV-listed and scopes are mixed, so every tier is populated.
  await measure("list sort=priority (default)", 25000, path, (body) => body.items.length === 50);
  await measure(
    "list sort=priority priority=p1",
    25000,
    `${path}?priority=p1`,
    (body) => body.items.length === 50,
  );
  await measure(
    "list sort=severity",
    25000,
    `${path}?sort=severity`,
    (body) => body.items.length === 50,
  );
  if (process.env["BENCH_EXPLAIN"]) {
    const { rows } = await pool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${findingSql({
        baseWhere: "f.org_id = $1 AND f.project_id = $2",
        where: ["s.status = 'open'"],
        order: "s.priority_tier, s.cvss_score DESC NULLS LAST, s.group_first_seen_at DESC, s.id",
        limit: "51",
      })}`,
      [org, project],
    );
    console.log(rows.map((r) => r["QUERY PLAN"]).join("\n"));
  }

  // SENTRA-16: one group at the response caps (52 advisories; the first 50 members plus the requested
  // one come back), each advisory with 64 KiB of details, 60 refs and 250 explicit versions.
  const detailPurl = "pkg:pypi/bench-detail@1.0";
  await pool.query(
    `INSERT INTO sbom_dependencies (import_id, org_id, project_id, purl, purl_type, name, version, ecosystem, scope, occurrences)
     VALUES ($1, $2, $3, $4, 'pypi', 'bench-detail', '1.0', 'PyPI', 'required', 1)`,
    [importId, org, project, detailPurl],
  );
  const { rows: bigAdvisories } = await pool.query<{ id: string }>(
    `INSERT INTO vulnerabilities (source, source_id, aliases, modified_at, severity, details, refs,
       cvss_score, cvss_version, cvss_calculated_at, source_artifact_sha256, source_entry, schema_version, adapter_version)
     SELECT 'osv', 'BIGGROUP-' || n, ARRAY['CVE-2026-9' || lpad(n::text, 3, '0')], now(), '[]',
       repeat('x', 70000),
       (SELECT jsonb_agg(jsonb_build_object('type', 'WEB', 'url', 'https://example.test/' || r))
        FROM generate_series(1, 60) r),
       5.5, '3.1', now(), $1, 'bench', 1, 1
     FROM generate_series(1, 52) n RETURNING id`,
    ["a".repeat(64)],
  );
  const groupId = randomUUID();
  await pool.query(
    "INSERT INTO vulnerability_groups (id, canonical_vulnerability_id) VALUES ($1, $2)",
    [groupId, bigAdvisories[0]!.id],
  );
  const ids = bigAdvisories.map((a) => a.id);
  await pool.query(
    `INSERT INTO vulnerability_group_members (vulnerability_id, group_id)
     SELECT unnest($1::uuid[]), $2`,
    [ids, groupId],
  );
  const { rows: bigFindings } = await pool.query<{ id: string }>(
    `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope,
       import_id, match_quality, matcher_version, evidence, first_seen_at)
     SELECT $1, $2, v, $3, '1.0', 'PyPI', 'required', $4, 'confirmed', 1,
       '{"rule":"range","comparator":"pep440","package":"bench-detail"}'::jsonb,
       now() + make_interval(secs => ord)
     FROM unnest($5::uuid[]) WITH ORDINALITY AS t(v, ord) RETURNING id`,
    [org, project, detailPurl, importId, ids],
  );
  await pool.query(
    `INSERT INTO vulnerability_affected (id, vulnerability_id, ecosystem, package_name, versions)
     SELECT gen_random_uuid(), v, 'PyPI', 'Bench_Detail',
       (SELECT array_agg('0.' || n) FROM generate_series(1, 250) n)
     FROM unnest($1::uuid[]) AS t(v)`,
    [ids],
  );
  await pool.query("ANALYZE findings, vulnerabilities, vulnerability_affected");
  await measure(
    "detail",
    25052,
    `${path}/${bigFindings.at(-1)!.id}`,
    (body) => body.members.length === 51 && body.membersTruncated === true,
  );
} finally {
  await app?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  await admin.end();
}
