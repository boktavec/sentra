// Real Postgres, real app routes. Identity is the only thing faked (see orgs.integration.test.ts).
// Findings are written by the correlator, so they are seeded with SQL. Needs `task stack:up`.
// Run with `task api:test:integration`.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, unauthenticated } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createFindingStore } from "./findings.ts";
import { createInvitationStore } from "./invitations.ts";
import { createMemberStore } from "./members.ts";
import { migrate } from "./migrate.ts";
import { createOrgStore } from "./orgs.ts";
import { createProjectStore } from "./projects.ts";
import { createUserStore } from "./users.ts";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required (see `task api:test:integration`)");

const logger = createLogger("api-test", {
  level: "debug",
  destination: new Writable({ write: (_chunk, _enc, done) => done() }),
});

let pool: Pool;
let app: ReturnType<typeof buildApp>;
const run = randomUUID().slice(0, 8);

async function newUser() {
  const user = await createUserStore(pool).resolve({
    issuer: "http://findings.test",
    subject: randomUUID(),
  });
  return { id: user.id, headers: { "x-test-user": user.id } };
}

/** An org with one admin and a plain member, and a project in it. */
async function newProject(slug = "web-app") {
  const admin = await newUser();
  const member = await newUser();
  const created = await app.inject({
    method: "POST",
    url: "/v1/orgs",
    headers: admin.headers,
    payload: { name: "Team", slug: `team-${run}-${randomUUID().slice(0, 8)}` },
  });
  const org: { id: string } = created.json();
  await pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [
    org.id,
    member.id,
  ]);
  const project = await app.inject({
    method: "POST",
    url: `/v1/orgs/${org.id}/projects`,
    headers: admin.headers,
    payload: { name: slug, slug },
  });
  expect(project.statusCode, project.body).toBe(201);
  return { org, admin, member, slug, projectId: project.json().id as string };
}

async function importFor(orgId: string, projectId: string, userId: string) {
  const { rows } = await pool.query(
    `INSERT INTO sbom_imports (org_id, project_id, created_by, filename, status, object_key, expires_at)
     VALUES ($1, $2, $3, 'bom.json', 'parsed', $4, now()) RETURNING id`,
    [orgId, projectId, userId, `k-${randomUUID()}`],
  );
  return rows[0].id as string;
}

async function advisory(sourceId: string) {
  const { rows } = await pool.query(
    `INSERT INTO vulnerabilities (source, source_id, aliases, summary, severity, modified_at,
       source_artifact_sha256, source_entry, schema_version, adapter_version)
     VALUES ('osv', $1, ARRAY['CVE-2026-0001'], 'A bug', '[{"type":"CVSS_V3","vector":"CVSS:3.1/AV:N"}]',
       now(), $2, 'e', 1, 1) RETURNING id`,
    [`${sourceId}-${run}-${randomUUID().slice(0, 6)}`, "a".repeat(64)],
  );
  return rows[0].id as string;
}

interface Seed {
  orgId: string;
  projectId: string;
  importId: string;
  purl: string;
  firstSeen?: string;
  status?: "open" | "resolved";
  quality?: "confirmed" | "unverifiable";
}

async function finding(s: Seed) {
  const resolved = s.status === "resolved";
  const quality = s.quality ?? "confirmed";
  const { rows } = await pool.query(
    `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope, import_id,
       match_quality, match_reason, status, resolved_reason, resolved_at, first_seen_at, matcher_version, evidence)
     VALUES ($1, $2, $3, $4, '1.0.0', 'PyPI', 'required', $5, $6, $7, $8, $9, $10, $11, 1, $12) RETURNING id`,
    [
      s.orgId,
      s.projectId,
      await advisory("PYSEC"),
      s.purl,
      s.importId,
      quality,
      quality === "unverifiable" ? "version_unparseable" : null,
      s.status ?? "open",
      resolved ? "dependency_removed" : null,
      resolved ? new Date() : null,
      s.firstSeen ?? new Date().toISOString(),
      JSON.stringify({ rule: "range", comparator: "pep440", package: "trac" }),
    ],
  );
  return rows[0].id as string;
}

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers });
const listUrl = (orgId: string, slug: string, query = "") =>
  `/v1/orgs/${orgId}/projects/${slug}/findings${query}`;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 10 });
  await migrate(pool);
  const userStore = createUserStore(pool);
  app = buildApp({
    logger,
    orgs: createOrgStore(pool, { maxOrgsPerUser: 100 }),
    members: createMemberStore(pool),
    projects: createProjectStore(pool),
    findings: createFindingStore(pool),
    invitations: createInvitationStore(pool, {
      fetchProfile: async () => ({ emailVerified: false }),
      webUrl: "http://localhost:3000",
      limits: { ttlHours: 1, maxPending: 1, maxPerDay: 1, maxMembers: 1 },
    }),
    trustedProxies: false,
    ready: async () => true,
    authenticate: async (request) => {
      const id = request.headers["x-test-user" as "authorization"];
      if (!id) throw unauthenticated("missing_token");
      const { rows } = await pool.query("SELECT issuer, subject FROM users WHERE id = $1", [id]);
      return userStore.resolve(rows[0]);
    },
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("listing findings", () => {
  it("returns the finding, its evidence and a summary of the advisory to any member", async () => {
    const { org, admin, member, slug, projectId } = await newProject();
    const importId = await importFor(org.id, projectId, admin.id);
    const id = await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/trac@1.0.0" });

    for (const user of [admin, member]) {
      const res = await get(listUrl(org.id, slug), user.headers);
      expect(res.statusCode).toBe(200);
      const { items, nextCursor } = res.json();
      expect(nextCursor).toBeNull();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id,
        purl: "pkg:pypi/trac@1.0.0",
        version: "1.0.0",
        ecosystem: "PyPI",
        scope: "required",
        status: "open",
        resolvedReason: null,
        matchQuality: "confirmed",
        matchReason: null,
        importId,
        evidence: { rule: "range", comparator: "pep440", package: "trac" },
        vulnerability: {
          aliases: ["CVE-2026-0001"],
          summary: "A bug",
          severity: [{ type: "CVSS_V3", vector: "CVSS:3.1/AV:N" }],
          source: "osv",
        },
      });
      // Internal bookkeeping is not part of the contract.
      expect(items[0]).not.toHaveProperty("matcherVersion");
      expect(items[0]).not.toHaveProperty("orgId");
    }
  });

  it("shows resolved and unverifiable findings with their reasons", async () => {
    const { org, admin, slug, projectId } = await newProject();
    const importId = await importFor(org.id, projectId, admin.id);
    await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/a@1", status: "resolved" });
    await finding({
      orgId: org.id,
      projectId,
      importId,
      purl: "pkg:pypi/b@latest",
      quality: "unverifiable",
    });

    const { items } = (await get(listUrl(org.id, slug), admin.headers)).json();

    const byPurl = Object.fromEntries(items.map((i: { purl: string }) => [i.purl, i]));
    expect(byPurl["pkg:pypi/a@1"]).toMatchObject({
      status: "resolved",
      resolvedReason: "dependency_removed",
    });
    expect(byPurl["pkg:pypi/b@latest"]).toMatchObject({
      matchQuality: "unverifiable",
      matchReason: "version_unparseable",
    });
  });

  it("pages newest first without skipping or repeating, including findings first seen at the same instant", async () => {
    const { org, admin, slug, projectId } = await newProject();
    const importId = await importFor(org.id, projectId, admin.id);
    const same = "2026-01-02T03:04:05.123456Z";
    const ids = [
      await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/a@1", firstSeen: same }),
      await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/b@1", firstSeen: same }),
      await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/c@1", firstSeen: same }),
      await finding({
        orgId: org.id,
        projectId,
        importId,
        purl: "pkg:pypi/old@1",
        firstSeen: "2025-12-31T00:00:00Z",
      }),
      await finding({
        orgId: org.id,
        projectId,
        importId,
        purl: "pkg:pypi/new@1",
        firstSeen: "2026-02-01T00:00:00Z",
      }),
    ];

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = listUrl(
        org.id,
        slug,
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      const body = (await get(url, admin.headers)).json();
      seen.push(...body.items.map((i: { id: string }) => i.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen[0]).toBe(ids[4]); // newest
    expect(seen[4]).toBe(ids[3]); // oldest
  });

  it("returns an empty page for a project without findings", async () => {
    const { org, admin, slug } = await newProject();
    const res = await get(listUrl(org.id, slug), admin.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
  });

  it("never mixes in another project's findings, even in the same org", async () => {
    const { org, admin, slug, projectId } = await newProject();
    const other = await app.inject({
      method: "POST",
      url: `/v1/orgs/${org.id}/projects`,
      headers: admin.headers,
      payload: { name: "Other", slug: "other-app" },
    });
    const otherId = other.json().id as string;
    await finding({
      orgId: org.id,
      projectId: otherId,
      importId: await importFor(org.id, otherId, admin.id),
      purl: "pkg:pypi/elsewhere@1",
    });
    await finding({
      orgId: org.id,
      projectId,
      importId: await importFor(org.id, projectId, admin.id),
      purl: "pkg:pypi/here@1",
    });

    const { items } = (await get(listUrl(org.id, slug), admin.headers)).json();

    expect(items.map((i: { purl: string }) => i.purl)).toEqual(["pkg:pypi/here@1"]);
  });

  it("rejects bad input and unknown projects the same way as other list routes", async () => {
    const { org, admin, slug } = await newProject();
    expect((await get(listUrl(org.id, slug, "?limit=0"), admin.headers)).statusCode).toBe(400);
    expect((await get(listUrl(org.id, slug, "?limit=abc"), admin.headers)).statusCode).toBe(400);
    expect((await get(listUrl(org.id, slug, "?cursor=garbage"), admin.headers)).statusCode).toBe(
      400,
    );
    const missing = await get(listUrl(org.id, "no-such-project"), admin.headers);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().reason).toBeUndefined(); // the reason is logged, never sent
  });

  it("requires a signed-in user", async () => {
    const { org, slug } = await newProject();
    expect((await get(listUrl(org.id, slug))).statusCode).toBe(401);
  });
});
