// Tenant isolation regression suite (SENTRA-21). Real Postgres, real routes; only identity is faked
// (`x-test-user`). Needs `task stack:up`. Run with `task api:test:isolation` (also part of
// `task api:test:integration`).
//
// Contract pinned here: reaching across tenants is indistinguishable from reaching for something
// that does not exist, and it changes nothing. Three attackers, each against every route:
//   outsider  admin of org A only, aims at org B's URL                       -> 404, same as a random org
//   dual      admin of A and plain member of B, uses A's URL with B's IDs    -> same as random IDs
//   member    plain member of B on B's admin-only routes                     -> 403
// After every attempt, every org_id table (plus the org row) is compared with its snapshot.
//
// Adding a route under /v1: add a case to CASES (or an EXEMPT entry with a reason), or the
// coverage test fails. Adding a tenant-scoped resource: add its cases, and replace its `it.todo`.
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
import { createFindingStore } from "./findings.ts";
import { createInvestigationStore } from "./investigations.ts";
import { createProjectStore } from "./projects.ts";
import { createSbomStorage } from "./sbom-storage.ts";
import { createSbomStore } from "./sbom.ts";
import { createUserStore } from "./users.ts";

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see \`task api:test:isolation\`)`);
  return value;
};
const databaseUrl = need("DATABASE_URL");
const storage = createSbomStorage({
  endpoint: need("S3_ENDPOINT"),
  bucket: process.env["S3_BUCKET"] ?? "sentra-raw",
  accessKey: need("S3_ACCESS_KEY"),
  secretKey: need("S3_SECRET_KEY"),
});
const limits = { maxBytes: 1000, uploadTtlSeconds: 900, maxPendingPerProject: 3 };

const logger = createLogger("api-test", {
  level: "debug",
  destination: new Writable({ write: (_chunk, _enc, done) => done() }),
});

/** IDs a request is built from. Victim values are real; the reference set is all random. */
interface Target {
  orgId: string;
  orgSlug: string;
  /** Exists only in the victim org. */
  project: string;
  /** Exists in both orgs, so an import ID swapped between them resolves to a real project. */
  sharedProject: string;
  userId: string;
  importId: string;
  invitationId: string;
  findingId: string;
  investigationId: string;
}
interface Req {
  url: string;
  payload?: object;
}
interface Case {
  route: string;
  /** Admin-only routes must also refuse a plain member of the victim org with 403. */
  adminOnly?: boolean;
  /** False when the route has no child ID to swap (list, create, the org itself). */
  child?: boolean;
  build: (t: Target) => Req;
}

const org = (t: Target) => `/v1/orgs/${t.orgId}`;
const sbom = (t: Target, project: string) => `${org(t)}/projects/${project}/sboms`;

const CASES: Case[] = [
  { route: "GET /v1/orgs/:orgId", child: false, build: (t) => ({ url: org(t) }) },
  {
    route: "GET /v1/orgs/by-slug/:slug",
    child: false,
    build: (t) => ({ url: `/v1/orgs/by-slug/${t.orgSlug}` }),
  },
  {
    route: "GET /v1/orgs/:orgId/members",
    child: false,
    build: (t) => ({ url: `${org(t)}/members` }),
  },
  {
    route: "PATCH /v1/orgs/:orgId/members/:userId",
    adminOnly: true,
    build: (t) => ({ url: `${org(t)}/members/${t.userId}`, payload: { role: "admin" } }),
  },
  {
    route: "DELETE /v1/orgs/:orgId/members/:userId",
    adminOnly: true,
    build: (t) => ({ url: `${org(t)}/members/${t.userId}` }),
  },
  {
    route: "POST /v1/orgs/:orgId/invitations",
    adminOnly: true,
    child: false,
    build: (t) => ({
      url: `${org(t)}/invitations`,
      payload: { email: "intruder@example.com", role: "admin" },
    }),
  },
  {
    route: "GET /v1/orgs/:orgId/invitations",
    adminOnly: true,
    child: false,
    build: (t) => ({ url: `${org(t)}/invitations` }),
  },
  {
    route: "DELETE /v1/orgs/:orgId/invitations/:invitationId",
    adminOnly: true,
    build: (t) => ({ url: `${org(t)}/invitations/${t.invitationId}` }),
  },
  {
    route: "POST /v1/orgs/:orgId/projects",
    child: false,
    build: (t) => ({ url: `${org(t)}/projects`, payload: { name: "Intruder", slug: "intruder" } }),
  },
  {
    route: "GET /v1/orgs/:orgId/projects",
    child: false,
    build: (t) => ({ url: `${org(t)}/projects` }),
  },
  {
    route: "GET /v1/orgs/:orgId/projects/by-slug/:slug",
    build: (t) => ({ url: `${org(t)}/projects/by-slug/${t.project}` }),
  },
  {
    route: "POST /v1/orgs/:orgId/projects/:slug/sboms",
    build: (t) => ({
      url: sbom(t, t.project),
      payload: { filename: "bom.json", size_bytes: 10 },
    }),
  },
  {
    route: "GET /v1/orgs/:orgId/projects/:slug/sboms",
    build: (t) => ({ url: sbom(t, t.project) }),
  },
  {
    route: "GET /v1/orgs/:orgId/projects/:slug/sboms/:importId",
    build: (t) => ({ url: `${sbom(t, t.sharedProject)}/${t.importId}` }),
  },
  {
    // The shared project exists in both orgs, so the swapped-URL check resolves to a real, empty project.
    route: "GET /v1/orgs/:orgId/projects/:slug/findings",
    build: (t) => ({ url: `${org(t)}/projects/${t.sharedProject}/findings` }),
  },
  {
    route: "GET /v1/orgs/:orgId/projects/:slug/findings/:findingId",
    build: (t) => ({ url: `${org(t)}/projects/${t.sharedProject}/findings/${t.findingId}` }),
  },
  {
    route: "POST /v1/orgs/:orgId/projects/:slug/findings/:findingId/investigations",
    build: (t) => ({
      url: `${org(t)}/projects/${t.sharedProject}/findings/${t.findingId}/investigations`,
    }),
  },
  {
    route: "GET /v1/orgs/:orgId/projects/:slug/findings/:findingId/investigations",
    build: (t) => ({
      url: `${org(t)}/projects/${t.sharedProject}/findings/${t.findingId}/investigations`,
    }),
  },
  {
    route: "GET /v1/orgs/:orgId/projects/:slug/findings/:findingId/investigations/:investigationId",
    build: (t) => ({
      url: `${org(t)}/projects/${t.sharedProject}/findings/${t.findingId}/investigations/${t.investigationId}`,
    }),
  },
  {
    route: "POST /v1/orgs/:orgId/projects/:slug/sboms/:importId/complete",
    build: (t) => ({ url: `${sbom(t, t.sharedProject)}/${t.importId}/complete` }),
  },
];

/** Routes under /v1 that are not tenant-scoped on purpose. */
const EXEMPT: Record<string, string> = {
  "GET /v1/me": "returns the caller's own user ID only",
  "POST /v1/orgs": "creates a new org for the caller; no existing tenant is addressed",
  "GET /v1/orgs": "lists the caller's own orgs; checked separately below",
  "POST /v1/invitations/accept":
    "bearer-secret invitation token plus verified email; covered in invitations.integration.test.ts",
};

/** Tenant-scoped routes (anything under /v1) with neither a case nor an exemption. */
function uncovered(routes: string[], covered: string[]) {
  const known = new Set(covered);
  return routes.filter((r) => r.split(" ")[1]!.startsWith("/v1/") && !known.has(r));
}

/** "METHOD /path" for every /v1 route; filled by the onRoute hook added in beforeAll. */
const registered: string[] = [];

let pool: Pool;
let app: ReturnType<typeof buildApp>;
const run = randomUUID().slice(0, 8);
const headersOf = (id: string) => ({ "x-test-user": id });

async function newUser() {
  const user = await createUserStore(pool).resolve({
    issuer: "http://isolation.test",
    subject: randomUUID(),
  });
  return user.id;
}

async function call(userId: string | undefined, method: string, req: Req) {
  return app.inject({
    method: method as "GET",
    url: req.url,
    headers: userId ? headersOf(userId) : {},
    ...(req.payload ? { payload: req.payload } : {}),
  });
}

/** An org created through the API by a new admin. */
async function newOrg(admin: string) {
  const slug = `iso-${run}-${randomUUID().slice(0, 8)}`;
  const res = await call(admin, "POST", { url: "/v1/orgs", payload: { name: "Iso", slug } });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id as string, slug };
}
const join = (orgId: string, userId: string, role: string) =>
  pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)", [
    orgId,
    userId,
    role,
  ]);

interface World {
  outsider: string;
  dual: string;
  member: string;
  victim: Target;
  home: { id: string; slug: string };
}
let world: World;

/** The purl of the finding seeded into the victim's shared-app project. */
const FINDING_PURL = `pkg:pypi/isolation-${run}@1.0.0`;

/** Findings come from the correlator, not the API, so the victim's is inserted with SQL. */
async function seedFinding(orgId: string, importId: string) {
  const project = await pool.query("SELECT id FROM projects WHERE org_id = $1 AND slug = $2", [
    orgId,
    "shared-app",
  ]);
  const vuln = await pool.query(
    `INSERT INTO vulnerabilities (source, source_id, modified_at, source_artifact_sha256, source_entry,
       schema_version, adapter_version)
     VALUES ('osv', $1, now(), $2, 'e', 1, 1) RETURNING id`,
    [`ISO-${run}`, "a".repeat(64)],
  );
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope, import_id,
       match_quality, matcher_version, evidence)
     VALUES ($1, $2, $3, $4, '1.0.0', 'PyPI', 'required', $5, 'confirmed', 1, '{"rule":"explicit_version"}') RETURNING id`,
    [orgId, project.rows[0].id, vuln.rows[0].id, FINDING_PURL, importId],
  );
  return inserted.rows[0]!.id;
}

async function seed(): Promise<World> {
  const victimAdmin = await newUser();
  const outsider = await newUser(); // admin of A only
  const victimOrg = await newOrg(victimAdmin);
  const home = await newOrg(outsider);
  const dualUser = await newUser(); // admin of A, plain member of B
  await join(home.id, dualUser, "admin");
  const member = await newUser();
  await join(victimOrg.id, member, "member");
  await join(victimOrg.id, dualUser, "member");

  const mk = (orgId: string, admin: string, slug: string) =>
    call(admin, "POST", { url: `/v1/orgs/${orgId}/projects`, payload: { name: slug, slug } });
  expect((await mk(victimOrg.id, victimAdmin, "victim-only")).statusCode).toBe(201);
  expect((await mk(victimOrg.id, victimAdmin, "shared-app")).statusCode).toBe(201);
  expect((await mk(home.id, outsider, "shared-app")).statusCode).toBe(201);

  const imp = await call(victimAdmin, "POST", {
    url: `/v1/orgs/${victimOrg.id}/projects/shared-app/sboms`,
    payload: { filename: "bom.json", size_bytes: 10 },
  });
  expect(imp.statusCode).toBe(201);
  const findingId = await seedFinding(victimOrg.id, imp.json().id as string);
  const createdRun = await call(victimAdmin, "POST", {
    url: `/v1/orgs/${victimOrg.id}/projects/shared-app/findings/${findingId}/investigations`,
  });
  expect(createdRun.statusCode).toBe(201);
  const inv = await call(victimAdmin, "POST", {
    url: `/v1/orgs/${victimOrg.id}/invitations`,
    payload: { email: `victim-${run}@example.com`, role: "member" },
  });
  expect(inv.statusCode).toBe(201);

  return {
    outsider,
    dual: dualUser,
    member,
    home,
    victim: {
      orgId: victimOrg.id,
      orgSlug: victimOrg.slug,
      project: "victim-only",
      sharedProject: "shared-app",
      userId: member,
      importId: imp.json().id as string,
      invitationId: inv.json().id as string,
      findingId,
      investigationId: createdRun.json().id as string,
    },
  };
}

/** Every row of every table with an org_id column, plus the org row, as one comparable value. */
async function snapshot(orgIds: string[]) {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'org_id' ORDER BY table_name`,
  );
  const out: Record<string, unknown> = {};
  for (const orgId of orgIds) {
    out[`organizations:${orgId}`] = (
      await pool.query("SELECT * FROM organizations WHERE id = $1", [orgId])
    ).rows;
    for (const { table_name } of tables) {
      out[`${table_name}:${orgId}`] = (
        await pool.query(
          `SELECT t::text AS r FROM "${table_name}" t WHERE org_id = $1 ORDER BY 1`,
          [orgId],
        )
      ).rows;
    }
  }
  return out;
}

/** What the caller can observe, minus the per-request correlation ID. */
const seen = (res: Awaited<ReturnType<typeof call>>) => {
  const body = res.body ? JSON.parse(res.body) : {};
  delete body.correlationId;
  return { status: res.statusCode, type: res.headers["content-type"], body };
};

const randomTarget = (t: Target, keep: Partial<Target> = {}): Target => ({
  orgId: randomUUID(),
  orgSlug: `nope-${randomUUID().slice(0, 8)}`,
  project: `nope-${randomUUID().slice(0, 8)}`,
  sharedProject: t.sharedProject, // a real project in the caller's own org for (c)
  userId: randomUUID(),
  importId: randomUUID(),
  invitationId: randomUUID(),
  findingId: randomUUID(),
  investigationId: randomUUID(),
  ...keep,
});

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 10 });
  await migrate(pool);
  await storage.ensureDevBucket("http://localhost:3000");
  const userStore = createUserStore(pool);
  app = buildApp({
    logger,
    orgs: createOrgStore(pool, { maxOrgsPerUser: 100 }),
    members: createMemberStore(pool),
    projects: createProjectStore(pool),
    findings: createFindingStore(pool),
    investigations: createInvestigationStore(pool, { modelId: "test-model", maxPendingPerOrg: 5 }),
    sbom: createSbomStore(pool, { storage, limits }),
    sbomMaxBytes: limits.maxBytes,
    invitations: createInvitationStore(pool, {
      fetchProfile: async () => ({ emailVerified: false }),
      webUrl: "http://localhost:3000",
      limits: { ttlHours: 1, maxPending: 5, maxPerDay: 10, maxMembers: 10 },
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
  // Routes sit in a plugin that registers on ready(), so a hook added now still sees them.
  app.addHook("onRoute", (o) => {
    for (const m of [o.method].flat()) if (m !== "HEAD") registered.push(`${m} ${o.url}`);
  });
  await app.ready();
  world = await seed();
});
afterAll(async () => {
  await app.close();
  await pool.end();
  storage.destroy();
});

describe("route coverage", () => {
  it("has an isolation case or a reasoned exemption for every /v1 route", () => {
    expect(registered.length).toBeGreaterThan(15); // the hook saw the routes, not nothing
    const covered = [...CASES.map((c) => c.route), ...Object.keys(EXEMPT)];
    expect(uncovered(registered, covered)).toEqual([]);
  });

  it("has no case for a route that no longer exists", () => {
    const routes = new Set(registered);
    const stale = [...CASES.map((c) => c.route), ...Object.keys(EXEMPT)].filter(
      (r) => !routes.has(r),
    );
    expect(stale).toEqual([]);
  });

  it("flags a new route with no case (the check itself works)", () => {
    expect(uncovered(["GET /v1/orgs/:orgId/findings", "GET /healthz"], ["GET /v1/me"])).toEqual([
      "GET /v1/orgs/:orgId/findings",
    ]);
  });
});

describe.each(CASES)("$route", (c) => {
  it("is a 404 for an outsider, the same as for a random org, and changes nothing", async () => {
    const { victim, outsider, home } = world;
    const before = await snapshot([victim.orgId, home.id]);
    const [real, reference] = [
      await call(outsider, c.route.split(" ")[0]!, c.build(victim)),
      await call(outsider, c.route.split(" ")[0]!, c.build(randomTarget(victim))),
    ];
    expect(real.statusCode).toBe(404);
    expect(seen(real)).toEqual(seen(reference));
    expect(real.body).not.toContain(victim.orgId);
    expect(await snapshot([victim.orgId, home.id])).toEqual(before);
  });

  it("is a 401 with no identity", async () => {
    const res = await call(undefined, c.route.split(" ")[0]!, c.build(world.victim));
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(world.victim.orgId);
  });

  it.runIf(c.child !== false)(
    "does not resolve another org's IDs through the caller's own org URL",
    async () => {
      const { victim, dual, home } = world;
      // The caller's own org in the URL; everything else belongs to the victim org.
      const swapped: Target = { ...victim, orgId: home.id, orgSlug: home.slug };
      const control = randomTarget(victim, { orgId: home.id, orgSlug: home.slug });
      const before = await snapshot([victim.orgId, home.id]);
      const method = c.route.split(" ")[0]!;
      const real = await call(dual, method, c.build(swapped));
      const reference = await call(dual, method, c.build(control));
      expect(seen(real)).toEqual(seen(reference));
      expect(await snapshot([victim.orgId, home.id])).toEqual(before);
    },
  );

  it.runIf(c.adminOnly)("is a 403 for a plain member of the victim org", async () => {
    const { victim, dual } = world;
    const before = await snapshot([victim.orgId]);
    const res = await call(dual, c.route.split(" ")[0]!, c.build(victim));
    expect(res.statusCode).toBe(403);
    expect(await snapshot([victim.orgId])).toEqual(before);
  });
});

describe("GET /v1/orgs", () => {
  it("does not list orgs the caller is not a member of", async () => {
    const res = await call(world.outsider, "GET", { url: "/v1/orgs" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(world.victim.orgId);
  });
});

describe("findings", () => {
  const url = (orgId: string, project = "shared-app") =>
    `/v1/orgs/${orgId}/projects/${project}/findings`;

  it("are readable by a member of the owning org (so the 404s above are not a broken route)", async () => {
    const res = await call(world.member, "GET", { url: url(world.victim.orgId) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { purl: string }) => i.purl)).toEqual([FINDING_PURL]);
  });

  it("keeps filtered and sorted findings inside the same tenant boundary", async () => {
    for (const query of [
      "?status=all&sort=newest",
      "?severity=unavailable",
      "?status=resolved&severity=critical",
      "?sort=priority&priority=p1",
      "?status=all&sort=priority&priority=p3",
    ]) {
      const outsider = await call(world.outsider, "GET", {
        url: `${url(world.victim.orgId)}${query}`,
      });
      expect(outsider.statusCode).toBe(404);
      expect(outsider.body).not.toContain(FINDING_PURL);
      const sameSlug = await call(world.outsider, "GET", { url: `${url(world.home.id)}${query}` });
      expect(sameSlug.statusCode).toBe(200);
      expect(sameSlug.body).not.toContain(FINDING_PURL);
    }
  });

  it("do not leak through a same-named project in another org, or to an outsider", async () => {
    const { outsider, dual, home, victim } = world;
    const ownProject = await call(outsider, "GET", { url: url(home.id) });
    expect(ownProject.statusCode).toBe(200);
    expect(ownProject.json()).toEqual({ items: [], nextCursor: null });
    const viaHome = await call(dual, "GET", { url: url(home.id) });
    expect(viaHome.body).not.toContain(FINDING_PURL);
    const reach = await call(outsider, "GET", { url: url(victim.orgId) });
    expect(reach.statusCode).toBe(404);
    expect(reach.body).not.toContain(FINDING_PURL);
  });

  describe("detail", () => {
    const detail = (orgId: string, project: string, findingId: string) =>
      `${url(orgId, project)}/${findingId}`;

    it("is readable by a member of the owning org (so the 404s below are not a broken route)", async () => {
      const res = await call(world.member, "GET", {
        url: detail(world.victim.orgId, "shared-app", world.victim.findingId),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().purl).toBe(FINDING_PURL);
    });

    it("answers every way of reaching the victim's finding like a finding that does not exist", async () => {
      const { outsider, dual, home, victim } = world;
      const reference = seen(
        await call(dual, "GET", { url: detail(home.id, "shared-app", randomUUID()) }),
      );
      const [crossTenant, malformed, nonMember] = await Promise.all([
        // Another org's finding under the caller's own org and a same-named project.
        call(dual, "GET", { url: detail(home.id, "shared-app", victim.findingId) }),
        call(dual, "GET", { url: detail(home.id, "shared-app", "not-a-uuid") }),
        // The victim's org and project, by a caller who is not a member.
        call(outsider, "GET", { url: detail(victim.orgId, "shared-app", victim.findingId) }),
      ]);
      for (const res of [crossTenant, malformed, nonMember]) {
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain(FINDING_PURL);
        expect(res.body).not.toContain(victim.orgId);
      }
      expect(seen(crossTenant)).toEqual(reference);
      expect(seen(malformed)).toEqual(reference);
    });

    it("does not resolve a finding of another project in the same org", async () => {
      const { member, victim } = world;
      const res = await call(member, "GET", {
        url: detail(victim.orgId, victim.project, victim.findingId),
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(FINDING_PURL);
    });
  });
});

// Not built yet. Each story that adds one of these registers its routes in CASES (the coverage
// test fails until it does) and replaces the todo.
describe("pending resources", () => {
  it.todo("audit records: cross-tenant read (SENTRA-20)");
});
