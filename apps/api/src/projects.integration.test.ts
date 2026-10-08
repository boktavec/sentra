// Real Postgres, real app routes. Identity is the only thing faked (see orgs.integration.test.ts):
// `x-test-user` picks a real user row. Members are seeded with SQL. Needs `task stack:up`.
// Run with `task api:test:integration`.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, unauthenticated } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createInvitationStore } from "./invitations.ts";
import { createMemberStore } from "./members.ts";
import { migrate } from "./migrate.ts";
import { createOrgStore } from "./orgs.ts";
import { createProjectStore } from "./projects.ts";
import { createUserStore } from "./users.ts";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required (see `task api:test:integration`)");

const logLines: Record<string, unknown>[] = [];
const logger = createLogger("api-test", {
  level: "debug",
  destination: new Writable({
    write(chunk, _enc, done) {
      logLines.push(JSON.parse(chunk.toString()));
      done();
    },
  }),
});

let pool: Pool;
let app: ReturnType<typeof buildApp>;
const run = randomUUID().slice(0, 8);

type Headers = Record<string, string>;

async function newUser() {
  const user = await createUserStore(pool).resolve({
    issuer: "http://projects.test",
    subject: randomUUID(),
  });
  return { id: user.id, headers: { "x-test-user": user.id } };
}

/** An org created through the API by a new admin; `member` is seeded in with SQL. */
async function newOrg() {
  const admin = await newUser();
  const member = await newUser();
  const res = await app.inject({
    method: "POST",
    url: "/v1/orgs",
    headers: admin.headers,
    payload: { name: "Team", slug: `team-${run}-${randomUUID().slice(0, 8)}` },
  });
  expect(res.statusCode).toBe(201);
  const org: { id: string } = res.json();
  await pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [
    org.id,
    member.id,
  ]);
  return { org, admin, member };
}

const createIn = (orgId: string, headers: Headers, payload: unknown) =>
  app.inject({
    method: "POST",
    url: `/v1/orgs/${orgId}/projects`,
    headers,
    payload: payload as object,
  });
const getUrl = (url: string, headers: Headers) => app.inject({ method: "GET", url, headers });
const count = async (sql: string, params: unknown[]) =>
  (await pool.query(sql, params)).rows[0].n as number;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 20 });
  await migrate(pool);
  const userStore = createUserStore(pool);
  app = buildApp({
    logger,
    orgs: createOrgStore(pool, { maxOrgsPerUser: 100 }),
    members: createMemberStore(pool),
    projects: createProjectStore(pool),
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

describe("creating a project", () => {
  it("lets an admin and a plain member create; writes one audit event each", async () => {
    const { org, admin, member } = await newOrg();
    for (const [user, slug] of [
      [admin, "web-app"],
      [member, "mobile-app"],
    ] as const) {
      const res = await createIn(org.id, user.headers, { name: "App", slug });
      expect(res.statusCode).toBe(201);
      const project = res.json();
      expect(project).toMatchObject({ orgId: org.id, name: "App", slug });
      expect(project.id).toMatch(/^[0-9a-f-]{36}$/);

      const row = (await pool.query("SELECT * FROM projects WHERE id = $1", [project.id])).rows[0];
      expect(row).toMatchObject({ org_id: org.id, created_by: user.id });
      expect(row.updated_at).toBeInstanceOf(Date);
      const audit = (
        await pool.query("SELECT * FROM audit_events WHERE target_id = $1", [project.id])
      ).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        org_id: org.id,
        actor_user_id: user.id,
        action: "project.created",
        target_type: "project",
        correlation_id: res.headers["x-correlation-id"],
        metadata: { slug },
      });
    }
    expect(logLines.some((l) => l["message"] === "project_created" && l["orgId"] === org.id)).toBe(
      true,
    );
  });

  it("allows repeated names, and the same slug in different orgs", async () => {
    const a = await newOrg();
    const b = await newOrg();
    expect(
      (await createIn(a.org.id, a.admin.headers, { name: "App", slug: "app-a" })).statusCode,
    ).toBe(201);
    expect(
      (await createIn(a.org.id, a.admin.headers, { name: "App", slug: "app-b" })).statusCode,
    ).toBe(201);
    expect(
      (await createIn(b.org.id, b.admin.headers, { name: "App", slug: "app-a" })).statusCode,
    ).toBe(201);
  });

  it("returns 409 for a slug used by a differently named project", async () => {
    const { org, admin } = await newOrg();
    await createIn(org.id, admin.headers, { name: "One", slug: "taken" });
    const res = await createIn(org.id, admin.headers, { name: "Two", slug: "taken" });
    expect(res.statusCode).toBe(409);
    expect(await count("SELECT count(*)::int AS n FROM projects WHERE org_id = $1", [org.id])).toBe(
      1,
    );
  });

  it("treats a retry as success with one project and one audit event", async () => {
    const { org, admin } = await newOrg();
    const first = await createIn(org.id, admin.headers, { name: "Web", slug: "retry" });
    const second = await createIn(org.id, admin.headers, { name: "Web", slug: "retry" });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM audit_events WHERE org_id = $1 AND action = 'project.created'",
        [org.id],
      ),
    ).toBe(1);
  });

  it("creates exactly one project when the same request races", async () => {
    const { org, admin, member } = await newOrg();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createIn(org.id, (i % 2 ? admin : member).headers, { name: "Race", slug: "race" }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.every((r) => r.statusCode === 201 || r.statusCode === 200)).toBe(true);
    expect(await count("SELECT count(*)::int AS n FROM projects WHERE org_id = $1", [org.id])).toBe(
      1,
    );
    expect(
      await count(
        "SELECT count(*)::int AS n FROM audit_events WHERE org_id = $1 AND action = 'project.created'",
        [org.id],
      ),
    ).toBe(1);
  });

  it("returns 409 to the loser when two different names race for one slug", async () => {
    const { org, admin, member } = await newOrg();
    const results = await Promise.all([
      createIn(org.id, admin.headers, { name: "Alpha", slug: "dup" }),
      createIn(org.id, member.headers, { name: "Beta", slug: "dup" }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it("rejects invalid input with 400 and writes nothing", async () => {
    const { org, admin } = await newOrg();
    for (const payload of [
      {},
      { name: "", slug: "valid-slug" },
      { name: "x".repeat(81), slug: "valid-slug" },
      { name: "bad\u0007name", slug: "valid-slug" },
      { name: "Ok", slug: "Bad_Slug" },
      { name: "Ok", slug: "-leading" },
      { name: "Ok", slug: "ab" },
      { name: "Ok", slug: "new" },
      { name: 5, slug: "valid-slug" },
    ]) {
      expect((await createIn(org.id, admin.headers, payload)).statusCode).toBe(400);
    }
    expect(await count("SELECT count(*)::int AS n FROM projects WHERE org_id = $1", [org.id])).toBe(
      0,
    );
  });

  it("ignores tenant and actor fields in the body", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const res = await createIn(a.org.id, a.admin.headers, {
      name: "Mine",
      slug: "mine",
      orgId: b.org.id,
      org_id: b.org.id,
      createdBy: b.admin.id,
    });
    expect(res.statusCode).toBe(201);
    const row = (
      await pool.query("SELECT org_id, created_by FROM projects WHERE id = $1", [res.json().id])
    ).rows[0];
    expect(row).toEqual({ org_id: a.org.id, created_by: a.admin.id });
  });

  it("rolls everything back when the audit insert fails", async () => {
    const { org, admin } = await newOrg();
    const fn = `fail_audit_${run}_${randomUUID().slice(0, 6)}`;
    await pool.query(
      `CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN
         IF NEW.org_id = '${org.id}' THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
    );
    await pool.query(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      const res = await createIn(org.id, admin.headers, { name: "Doomed", slug: "doomed" });
      expect(res.statusCode).toBe(500);
      expect(
        await count("SELECT count(*)::int AS n FROM projects WHERE org_id = $1", [org.id]),
      ).toBe(0);
    } finally {
      await pool.query(`DROP TRIGGER ${fn} ON audit_events`);
      await pool.query(`DROP FUNCTION ${fn}()`);
    }
  });
});

describe("tenant isolation", () => {
  it("answers a non-member exactly like a missing org, on every route, and writes nothing", async () => {
    const { org, admin } = await newOrg();
    const outsider = await newUser();
    await createIn(org.id, admin.headers, { name: "Secret", slug: "secret" });
    const missing = randomUUID();

    const probe = async (orgId: string, headers: Headers) => [
      await createIn(orgId, headers, { name: "X", slug: "intruder" }),
      await getUrl(`/v1/orgs/${orgId}/projects`, headers),
      await getUrl(`/v1/orgs/${orgId}/projects/by-slug/secret`, headers),
    ];
    const denied = await probe(org.id, outsider.headers);
    const absent = await probe(missing, outsider.headers);
    for (const [i, res] of denied.entries()) {
      expect(res.statusCode).toBe(404);
      // Everything but the per-request correlation ID must be identical.
      const body = ({ status, title, type }: Record<string, unknown>) => ({ status, title, type });
      expect(body(res.json())).toEqual(body(absent[i]!.json()));
    }
    expect(await count("SELECT count(*)::int AS n FROM projects WHERE slug = 'intruder'", [])).toBe(
      0,
    );
    expect((await getUrl("/v1/orgs/not-a-uuid/projects", outsider.headers)).statusCode).toBe(404);
  });

  it("does not find a project through another org, even for a member of both", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await createIn(a.org.id, a.admin.headers, { name: "A only", slug: "a-only" });
    expect(
      (await getUrl(`/v1/orgs/${b.org.id}/projects/by-slug/a-only`, b.admin.headers)).statusCode,
    ).toBe(404);
    const list = (await getUrl(`/v1/orgs/${b.org.id}/projects`, b.admin.headers)).json();
    expect(list.items).toEqual([]);
  });

  it("requires authentication", async () => {
    const { org } = await newOrg();
    expect((await createIn(org.id, {}, { name: "X", slug: "anon" })).statusCode).toBe(401);
    expect((await getUrl(`/v1/orgs/${org.id}/projects`, {})).statusCode).toBe(401);
  });
});

describe("reading projects", () => {
  it("gets a project by slug and 404s an unknown slug", async () => {
    const { org, member } = await newOrg();
    await createIn(org.id, member.headers, { name: "Web", slug: "web" });
    const res = await getUrl(`/v1/orgs/${org.id}/projects/by-slug/web`, member.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orgId: org.id, name: "Web", slug: "web" });
    expect(
      (await getUrl(`/v1/orgs/${org.id}/projects/by-slug/nope`, member.headers)).statusCode,
    ).toBe(404);
  });

  it("pages through projects in creation order without gaps or repeats", async () => {
    const { org, admin } = await newOrg();
    const slugs = Array.from({ length: 7 }, (_, i) => `proj-${i}`);
    for (const slug of slugs) await createIn(org.id, admin.headers, { name: slug, slug });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/orgs/${org.id}/projects?limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const page = (await getUrl(url, admin.headers)).json();
      seen.push(...page.items.map((p: { slug: string }) => p.slug));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(slugs);
    expect(pages).toBe(3);
  });

  it("rejects a bad limit or a tampered cursor with 400", async () => {
    const { org, admin } = await newOrg();
    for (const query of ["limit=0", "limit=101", "limit=abc", "cursor=garbage"]) {
      expect((await getUrl(`/v1/orgs/${org.id}/projects?${query}`, admin.headers)).statusCode).toBe(
        400,
      );
    }
  });
});
