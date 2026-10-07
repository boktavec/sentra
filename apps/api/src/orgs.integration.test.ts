// Real Postgres, real app routes. Identity is the only thing faked: SENTRA-1's tests already cover
// real Zitadel JWTs, and this suite needs several distinct users, so `x-test-user` picks one and
// resolves it through the real user store. Needs `task stack:up`. Run with `task api:test:integration`.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, unauthenticated } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { migrate } from "./migrate.ts";
import { createInvitationStore } from "./invitations.ts";
import { createMemberStore } from "./members.ts";
import { createOrgStore } from "./orgs.ts";
import { createUserStore } from "./users.ts";

const MAX = 3;
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
const slug = (name: string) => `${name}-${run}`;

/** Creates a distinct real user row and returns the header that authenticates as them. */
async function newUser() {
  const users = createUserStore(pool);
  const user = await users.resolve({ issuer: "http://orgs.test", subject: randomUUID() });
  return { id: user.id, headers: { "x-test-user": user.id } };
}

const post = (headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: "POST", url: "/v1/orgs", headers, payload: payload as object });
const get = (headers: Record<string, string>, url: string) =>
  app.inject({ method: "GET", url, headers });
const count = async (table: string, where: string, params: unknown[]) =>
  (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 20 });
  await migrate(pool);
  const userStore = createUserStore(pool);
  app = buildApp({
    logger,
    orgs: createOrgStore(pool, { maxOrgsPerUser: MAX }),
    members: createMemberStore(pool),
    invitations: createInvitationStore(pool, {
      fetchProfile: async () => ({ emailVerified: false }),
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

describe("creating an organization", () => {
  it("creates the org, an admin membership and one audit event, with a UUID independent of the name", async () => {
    const user = await newUser();
    const res = await post(user.headers, { name: "Acme", slug: slug("acme") });
    expect(res.statusCode).toBe(201);
    const org = res.json();
    expect(org).toMatchObject({ name: "Acme", slug: slug("acme"), role: "admin" });
    expect(org.id).toMatch(/^[0-9a-f-]{36}$/);

    const { rows } = await pool.query("SELECT user_id, role FROM memberships WHERE org_id = $1", [
      org.id,
    ]);
    expect(rows).toEqual([{ user_id: user.id, role: "admin" }]);
    const audit = await pool.query("SELECT * FROM audit_events WHERE org_id = $1", [org.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_user_id: user.id,
      action: "org.created",
      target_type: "organization",
      target_id: org.id,
      correlation_id: res.headers["x-correlation-id"],
    });
  });

  it("allows two orgs with the same display name but not the same slug", async () => {
    const a = await newUser();
    const b = await newUser();
    expect((await post(a.headers, { name: "Same", slug: slug("same-a") })).statusCode).toBe(201);
    expect((await post(b.headers, { name: "Same", slug: slug("same-b") })).statusCode).toBe(201);
    const taken = await post(b.headers, { name: "Other", slug: slug("same-a") });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().type).toBe("urn:sentra:error:slug_taken");
  });

  it("ignores tenant fields in the body: the ID is always generated", async () => {
    const user = await newUser();
    const forged = randomUUID();
    const res = await post(user.headers, {
      name: "X",
      slug: slug("forged"),
      id: forged,
      orgId: forged,
      role: "owner",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).not.toBe(forged);
    expect(res.json().role).toBe("admin");
  });

  it("rejects invalid input and unauthenticated callers with generic problem bodies", async () => {
    const user = await newUser();
    for (const payload of [
      {},
      { name: "", slug: "abc" },
      { name: "A", slug: "Bad_Slug" },
      { name: "A", slug: "admin" },
    ]) {
      const res = await post(user.headers, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe("urn:sentra:error:invalid_input");
    }
    expect((await post({}, { name: "A", slug: slug("anon") })).statusCode).toBe(401);
    expect(await count("organizations", "slug = $1", [slug("anon")])).toBe(0);
  });
});

describe("retries and races", () => {
  it("treats a retry as idempotent: same org, one audit event, even in parallel", async () => {
    const user = await newUser();
    const body = { name: "Retry", slug: slug("retry") };
    const results = await Promise.all(Array.from({ length: 8 }, () => post(user.headers, body)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    const id = results[0]!.json().id;
    expect(await count("audit_events", "org_id = $1", [id])).toBe(1);
    expect(await count("memberships", "org_id = $1", [id])).toBe(1);
  });

  it("does not treat a conflict as a retry when the name differs or the caller is not the admin", async () => {
    const owner = await newUser();
    const other = await newUser();
    await post(owner.headers, { name: "Mine", slug: slug("mine") });
    expect((await post(owner.headers, { name: "Renamed", slug: slug("mine") })).statusCode).toBe(
      409,
    );
    expect((await post(other.headers, { name: "Mine", slug: slug("mine") })).statusCode).toBe(409);
  });

  it("lets exactly one of two users win a simultaneous slug race", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const results = await Promise.all([
      post(a.headers, { name: "A", slug: slug("race") }),
      post(b.headers, { name: "B", slug: slug("race") }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await count("organizations", "slug = $1", [slug("race")])).toBe(1);
    expect(
      await count("audit_events", "org_id = (SELECT id FROM organizations WHERE slug = $1)", [
        slug("race"),
      ]),
    ).toBe(1);
  });
});

describe("limits and atomicity", () => {
  it("never exceeds the per-user cap under parallel creates, and a retry at the cap still succeeds", async () => {
    const user = await newUser();
    const results = await Promise.all(
      Array.from({ length: MAX + 4 }, (_, i) =>
        post(user.headers, { name: `C${i}`, slug: slug(`cap-${i}`) }),
      ),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(MAX);
    expect(statuses.filter((s) => s === 403)).toHaveLength(4);
    expect(results.find((r) => r.statusCode === 403)!.json().type).toBe(
      "urn:sentra:error:org_limit_reached",
    );
    expect(await count("memberships", "user_id = $1", [user.id])).toBe(MAX);

    const created = results.find((r) => r.statusCode === 201)!.json();
    const retry = await post(user.headers, { name: created.name, slug: created.slug });
    expect(retry.statusCode).toBe(200);
    // Rejected creates leave nothing behind.
    expect(await count("organizations", "created_by = $1", [user.id])).toBe(MAX);
  });

  it("rolls back the org and membership when the audit insert fails", async () => {
    const user = await newUser();
    await pool.query(`CREATE OR REPLACE FUNCTION fail_audit() RETURNS trigger AS $$
      BEGIN IF NEW.correlation_id = 'force-fail' THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await pool.query(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_audit()",
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/orgs",
        headers: { ...user.headers, "x-correlation-id": "force-fail" },
        payload: { name: "Doomed", slug: slug("doomed") },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await pool.query("DROP TRIGGER fail_audit ON audit_events");
      await pool.query("DROP FUNCTION fail_audit()");
    }
    expect(await count("organizations", "slug = $1", [slug("doomed")])).toBe(0);
    expect(await count("memberships", "user_id = $1", [user.id])).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("answers non-members exactly as it answers a nonexistent org, by UUID and by slug", async () => {
    const owner = await newUser();
    const intruder = await newUser();
    const org = (await post(owner.headers, { name: "Secret", slug: slug("secret") })).json();

    const asOwner = await get(owner.headers, `/v1/orgs/${org.id}`);
    expect(asOwner.statusCode).toBe(200);
    expect((await get(owner.headers, `/v1/orgs/by-slug/${org.slug}`)).json()).toEqual(
      asOwner.json(),
    );

    const normalize = (r: Awaited<ReturnType<typeof get>>) => ({
      status: r.statusCode,
      body: { ...r.json(), correlationId: "x" },
    });
    const missing = normalize(await get(intruder.headers, `/v1/orgs/${randomUUID()}`));
    expect(missing.status).toBe(404);
    for (const url of [
      `/v1/orgs/${org.id}`,
      `/v1/orgs/by-slug/${org.slug}`,
      "/v1/orgs/not-a-uuid",
      `/v1/orgs/by-slug/${slug("does-not-exist")}`,
    ]) {
      expect(normalize(await get(intruder.headers, url))).toEqual(missing);
    }
    expect(JSON.stringify(logLines)).not.toContain("Secret");
  });

  it("requires authentication for every org route", async () => {
    for (const url of ["/v1/orgs", `/v1/orgs/${randomUUID()}`, "/v1/orgs/by-slug/abc"]) {
      expect((await get({}, url)).statusCode).toBe(401);
    }
  });
});

describe("listing and logging", () => {
  it("lists only the caller's orgs and pages through them without gaps or repeats", async () => {
    const user = await newUser();
    const other = await newUser();
    await post(other.headers, { name: "Not yours", slug: slug("not-yours") });
    const created: string[] = [];
    for (let i = 0; i < MAX; i++) {
      created.push(
        (await post(user.headers, { name: `L${i}`, slug: slug(`list-${i}`) })).json().id,
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(user.headers, `/v1/orgs?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.statusCode).toBe(200);
      const page: { items: { id: string }[]; nextCursor: string | null } = res.json();
      seen.push(...page.items.map((o) => o.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(created);
    expect(pages).toBe(2);
  });

  it("rejects a bad limit or a tampered cursor with 400", async () => {
    const user = await newUser();
    for (const query of ["limit=0", "limit=101", "limit=abc", "cursor=garbage"]) {
      expect((await get(user.headers, `/v1/orgs?${query}`)).statusCode).toBe(400);
    }
  });

  it("puts the tenant ID in the request log of org-scoped routes and logs denied access", async () => {
    const owner = await newUser();
    const intruder = await newUser();
    const org = (await post(owner.headers, { name: "Logged", slug: slug("logged") })).json();
    logLines.length = 0;
    await get(owner.headers, `/v1/orgs/${org.id}`);
    await get(intruder.headers, `/v1/orgs/${org.id}`);
    const ok = logLines.find((l) => l["message"] === "tenant_resolved" && l["orgId"] === org.id);
    expect(ok).toMatchObject({ userId: owner.id });
    const denied = logLines.find((l) => l["message"] === "tenant_access_denied");
    expect(denied).toMatchObject({ userId: intruder.id, correlationId: expect.any(String) });
  });
});

describe("audit events are append-only", () => {
  it("rejects UPDATE and DELETE", async () => {
    const user = await newUser();
    const org = (await post(user.headers, { name: "Audited", slug: slug("audited") })).json();
    await expect(
      pool.query("UPDATE audit_events SET action = 'x' WHERE org_id = $1", [org.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM audit_events WHERE org_id = $1", [org.id]),
    ).rejects.toThrow(/append-only/);
    expect(await count("audit_events", "org_id = $1 AND action = 'org.created'", [org.id])).toBe(1);
  });
});
