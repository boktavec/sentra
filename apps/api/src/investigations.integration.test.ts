// Real Postgres and routes; only identity is substituted. Needs `task stack:up`.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, unauthenticated } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createFindingStore } from "./findings.ts";
import { createInvestigationStore } from "./investigations.ts";
import { createInvestigationRelay } from "./investigation-relay.ts";
import { createInvitationStore } from "./invitations.ts";
import { createMemberStore } from "./members.ts";
import { migrate } from "./migrate.ts";
import { createOrgStore } from "./orgs.ts";
import { createProjectStore } from "./projects.ts";
import { createUserStore } from "./users.ts";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL is required for investigations.integration.test.ts");
const pool = new Pool({ connectionString: url });
const logger = createLogger("investigation-test", {
  level: "debug",
  destination: new Writable({ write: (_chunk, _enc, done) => done() }),
});
const users = createUserStore(pool);
const store = createInvestigationStore(pool, { modelId: "test-local-model", maxPendingPerOrg: 2 });
const app = buildApp({
  logger,
  authenticate: async (request) => {
    const id = request.headers["x-test-user" as "authorization"];
    if (!id) throw unauthenticated("missing_token");
    const { rows } = await pool.query("SELECT issuer, subject FROM users WHERE id = $1", [id]);
    return users.resolve(rows[0]);
  },
  orgs: createOrgStore(pool, { maxOrgsPerUser: 100 }),
  members: createMemberStore(pool),
  projects: createProjectStore(pool),
  findings: createFindingStore(pool),
  investigations: store,
  invitations: createInvitationStore(pool, {
    fetchProfile: async () => ({ emailVerified: false }),
    webUrl: "http://localhost:3000",
    limits: { ttlHours: 1, maxPending: 5, maxPerDay: 10, maxMembers: 10 },
  }),
  trustedProxies: false,
  ready: async () => true,
});

let owner: string;
let member: string;
let orgId: string;
let projectId: string;
let findingId: string;
let resolvedId: string;
let groupId: string;
const slug = `inv-${randomUUID().slice(0, 8)}`;
const base = () => `/v1/orgs/${orgId}/projects/${slug}/findings/${findingId}/investigations`;
const call = (id: string, method: "GET" | "POST", path: string) =>
  app.inject({ method, url: path, headers: { "x-test-user": id } });

beforeAll(async () => {
  await migrate(pool);
  owner = (await users.resolve({ issuer: "http://investigation.test", subject: randomUUID() })).id;
  member = (await users.resolve({ issuer: "http://investigation.test", subject: randomUUID() })).id;
  const org = await createOrgStore(pool, { maxOrgsPerUser: 100 }).create(
    owner,
    { name: "Investigations", slug },
    randomUUID(),
  );
  orgId = org.org.id;
  await pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [
    orgId,
    member,
  ]);
  projectId = (
    await pool.query<{ id: string }>(
      "INSERT INTO projects (org_id, name, slug, created_by) VALUES ($1, 'App', $2, $3) RETURNING id",
      [orgId, slug, owner],
    )
  ).rows[0]!.id;
  const importId = (
    await pool.query<{ id: string }>(
      `INSERT INTO sbom_imports (org_id, project_id, created_by, filename, object_key, expires_at)
     VALUES ($1, $2, $3, 'bom.json', $4, now() + interval '1 day') RETURNING id`,
      [orgId, projectId, owner, `investigations/${randomUUID()}`],
    )
  ).rows[0]!.id;
  const vulnId = (
    await pool.query<{ id: string }>(
      `INSERT INTO vulnerabilities (source, source_id, modified_at, source_artifact_sha256, source_entry,
       schema_version, adapter_version, summary)
     VALUES ('osv', $1, now(), $2, 'entry', 1, 1, 'A real advisory summary') RETURNING id`,
      [`INV-${slug}`, "b".repeat(64)],
    )
  ).rows[0]!.id;
  const relatedId = (
    await pool.query<{ id: string }>(
      `INSERT INTO vulnerabilities (source, source_id, modified_at, source_artifact_sha256, source_entry,
         schema_version, adapter_version, summary)
       VALUES ('osv', $1, now(), $2, 'entry', 1, 1, 'A related advisory') RETURNING id`,
      [`INV-RELATED-${slug}`, "c".repeat(64)],
    )
  ).rows[0]!.id;
  groupId = randomUUID();
  await pool.query(
    "INSERT INTO vulnerability_groups (id, canonical_vulnerability_id) VALUES ($1, $2)",
    [groupId, vulnId],
  );
  await pool.query(
    "INSERT INTO vulnerability_group_members (vulnerability_id, group_id) VALUES ($1, $3), ($2, $3)",
    [vulnId, relatedId, groupId],
  );
  const rows = await pool.query<{ id: string; status: string }>(
    `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope, import_id,
       match_quality, match_reason, matcher_version, evidence, status, resolved_reason, resolved_at)
     VALUES ($1, $2, $3, $4, '1.0', 'PyPI', 'required', $5, 'unverifiable', 'no_version_data', 1,
       '{"rule":"no_version_data"}', $6, $7, $8) RETURNING id, status`,
    [orgId, projectId, vulnId, `pkg:pypi/${slug}@1.0`, importId, "open", null, null],
  );
  findingId = rows.rows[0]!.id;
  const resolved = await pool.query<{ id: string }>(
    `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope, import_id,
       match_quality, matcher_version, evidence, status, resolved_reason, resolved_at)
     VALUES ($1, $2, $3, $4, '2.0', 'PyPI', 'required', $5, 'confirmed', 1,
       '{"rule":"explicit_version"}', 'resolved', 'version_changed', now()) RETURNING id`,
    [orgId, projectId, vulnId, `pkg:pypi/${slug}@2.0`, importId],
  );
  resolvedId = resolved.rows[0]!.id;
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("investigation lifecycle API", () => {
  it("atomically creates one scoped run, outbox event, and audit entry; concurrent retries reuse it", async () => {
    const [a, b] = await Promise.all([call(owner, "POST", base()), call(owner, "POST", base())]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().id).toBe(b.json().id);
    const id = a.json().id as string;
    const db = await pool.query(
      `SELECT i.org_id, i.project_id, i.finding_id, i.created_by, i.context_snapshot,
              i.draft, i.prompt_version, o.payload, a.action
       FROM investigations i JOIN investigation_outbox o ON o.investigation_id = i.id
       JOIN audit_events a ON a.target_id = i.id WHERE i.id = $1`,
      [id],
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      org_id: orgId,
      project_id: projectId,
      finding_id: findingId,
      created_by: owner,
      draft: null,
      prompt_version: 3, // new runs end with a structured result; earlier versions keep theirs
      action: "investigation.created",
    });
    expect(db.rows[0].context_snapshot).toMatchObject({
      finding: { matchQuality: "unverifiable" },
      advisory: { summary: "A real advisory summary" },
      groupId,
      linkedAdvisories: expect.arrayContaining([
        expect.objectContaining({ summary: "A real advisory summary" }),
        expect.objectContaining({ summary: "A related advisory" }),
      ]),
    });
    expect(db.rows[0].payload).toMatchObject({
      type: "investigation.requested",
      orgId,
      projectId,
      investigationId: id,
    });
    expect(a.body).not.toContain("A real advisory summary");
  });

  it("shares history with a member, permits a new run after completion, and keeps drafts private", async () => {
    const first = (await call(owner, "POST", base())).json().id as string;
    await pool.query(
      "UPDATE investigations SET status = 'completed', draft = 'private model text', completed_at = now() WHERE id = $1",
      [first],
    );
    const second = await call(member, "POST", base());
    expect(second.statusCode).toBe(201);
    const history = await call(member, "GET", `${base()}?limit=1`);
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toHaveLength(1);
    expect(history.json().nextCursor).toBeTruthy();
    const next = await call(
      member,
      "GET",
      `${base()}?limit=1&cursor=${encodeURIComponent(history.json().nextCursor)}`,
    );
    expect(next.json().items[0].id).toBe(first);
    const status = await call(member, "GET", `${base()}/${first}`);
    expect(status.json().status).toBe("completed");
    expect(status.body).not.toContain("private model text");
  });

  it("serves a stored result to current members only, and hides it from status and history", async () => {
    const extra = (
      await users.resolve({ issuer: "http://investigation.test", subject: randomUUID() })
    ).id;
    await pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [
      orgId,
      extra,
    ]);
    const run = (
      await pool.query<{ id: string }>(
        `INSERT INTO investigations (org_id, project_id, finding_id, created_by, context_snapshot, model_id,
           prompt_version, status, completed_at)
         VALUES ($1, $2, $3, $4, '{}', 'm', 3, 'completed', now()) RETURNING id`,
        [orgId, projectId, findingId, extra],
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO investigation_results (investigation_id, org_id, project_id, attempt, schema_version, result)
       VALUES ($1, $2, $3, 1, 1, '{"summary":"stored explanation"}')`,
      [run, orgId, projectId],
    );
    const read = (user: string) => call(user, "GET", `${base()}/${run}/result`);

    const ok = await read(member);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      investigationId: run,
      schemaVersion: 1,
      result: { summary: "stored explanation" },
    });
    expect((await call(member, "GET", `${base()}/${run}`)).body).not.toContain(
      "stored explanation",
    );
    expect((await call(member, "GET", base())).body).not.toContain("stored explanation");

    // The creator of the run loses membership: the result is no longer theirs to read.
    await pool.query("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2", [orgId, extra]);
    expect((await read(extra)).statusCode).toBe(404);
    expect((await read(member)).statusCode).toBe(200);
  });

  it("refuses resolved findings and unknown IDs without writing", async () => {
    const before = (
      await pool.query("SELECT count(*)::int AS n FROM investigations WHERE org_id = $1", [orgId])
    ).rows[0].n;
    expect((await call(owner, "POST", base().replace(findingId, resolvedId))).statusCode).toBe(409);
    expect((await call(owner, "POST", base().replace(findingId, randomUUID()))).statusCode).toBe(
      404,
    );
    const after = (
      await pool.query("SELECT count(*)::int AS n FROM investigations WHERE org_id = $1", [orgId])
    ).rows[0].n;
    expect(after).toBe(before);
  });

  it("caps pending work per organization while still reusing an active run", async () => {
    const cloned = await pool.query<{ id: string }>(
      `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope,
         import_id, match_quality, match_reason, matcher_version, evidence, status)
       SELECT org_id, project_id, vulnerability_id, purl || '-cap-' || $2, version, ecosystem, scope,
         import_id, match_quality, match_reason, matcher_version, evidence, 'open'
       FROM findings WHERE id = $1 RETURNING id`,
      [findingId, randomUUID()],
    );
    const other = await pool.query<{ id: string }>(
      `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope,
         import_id, match_quality, match_reason, matcher_version, evidence, status)
       SELECT org_id, project_id, vulnerability_id, purl || '-cap-' || $2, version, ecosystem, scope,
         import_id, match_quality, match_reason, matcher_version, evidence, 'open'
       FROM findings WHERE id = $1 RETURNING id`,
      [findingId, randomUUID()],
    );
    const first = await call(owner, "POST", base().replace(findingId, cloned.rows[0]!.id));
    expect(first.statusCode).toBe(201);
    const rejected = await call(owner, "POST", base().replace(findingId, other.rows[0]!.id));
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json().type).toBe("urn:sentra:error:investigation_limit");
    const reused = await call(member, "POST", base().replace(findingId, cloned.rows[0]!.id));
    expect(reused.statusCode).toBe(200);
    expect(reused.json().id).toBe(first.json().id);
  });

  it("retries an unsent outbox row after publisher failure", async () => {
    let fail = true;
    const published: string[] = [];
    const relay = createInvestigationRelay(pool, {
      publisher: {
        async publish(_topic, _key, value) {
          if (fail) throw new Error("broker_down");
          published.push(value);
        },
      },
      logger,
      leaseSeconds: 1,
      backoffBaseSeconds: 1,
    });
    await relay.tick();
    const pending = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM investigation_outbox WHERE sent_at IS NULL AND attempts > 0",
    );
    expect(pending.rows[0]!.n).toBeGreaterThan(0);
    fail = false;
    await pool.query(
      "UPDATE investigation_outbox SET next_attempt_at = now() WHERE sent_at IS NULL",
    );
    await relay.tick();
    const remaining = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM investigation_outbox WHERE sent_at IS NULL",
    );
    expect(remaining.rows[0]!.n).toBe(0);
    expect(published.some((value) => JSON.parse(value).type === "investigation.requested")).toBe(
      true,
    );
  });
});
