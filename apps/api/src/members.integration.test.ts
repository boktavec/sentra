// Real Postgres, real app routes. Identity is the only thing faked (see orgs.integration.test.ts):
// `x-test-user` picks a real user row. Members are seeded with SQL because invitations are a
// later story. Needs `task stack:up`. Run with `task api:test:integration`.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, unauthenticated } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createInvitationStore } from "./invitations.ts";
import { createMemberStore } from "./members.ts";
import { migrate } from "./migrate.ts";
import { createFindingStore } from "./findings.ts";
import { createProjectStore } from "./projects.ts";
import { createOrgStore, type Role } from "./orgs.ts";
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

interface TestUser {
  id: string;
  email: string;
  headers: Record<string, string>;
}

async function newUser(label: string): Promise<TestUser> {
  const email = `${label}-${run}@example.com`;
  const user = await createUserStore(pool).resolve({
    issuer: "http://members.test",
    subject: randomUUID(),
    email,
    name: `User ${label}`,
  });
  return { id: user.id, email, headers: { "x-test-user": user.id } };
}

/** An org created through the API by `admin`, with the given users seeded in with SQL. */
async function newOrg(admin: TestUser, members: [TestUser, Role][] = []) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/orgs",
    headers: admin.headers,
    payload: { name: "Team", slug: `team-${randomUUID().slice(0, 12)}` },
  });
  expect(res.statusCode).toBe(201);
  const org: { id: string; slug: string } = res.json();
  for (const [user, role] of members) {
    await pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)", [
      org.id,
      user.id,
      role,
    ]);
  }
  return org;
}

const call = (
  who: TestUser | null,
  method: "GET" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
) => app.inject({ method, url, headers: who?.headers ?? {}, payload });
const members = (orgId: string, userId?: string) =>
  `/v1/orgs/${orgId}/members${userId ? `/${userId}` : ""}`;
const roleOf = async (orgId: string, userId: string) =>
  (
    await pool.query("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2", [
      orgId,
      userId,
    ])
  ).rows[0]?.role;
const audit = async (orgId: string, action: string) =>
  (
    await pool.query("SELECT * FROM audit_events WHERE org_id = $1 AND action = $2", [
      orgId,
      action,
    ])
  ).rows;
const adminCount = async (orgId: string) =>
  (
    await pool.query(
      "SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'admin'",
      [orgId],
    )
  ).rows[0].n;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 20 });
  await migrate(pool);
  const userStore = createUserStore(pool);
  app = buildApp({
    logger,
    orgs: createOrgStore(pool, { maxOrgsPerUser: 50 }),
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

describe("listing members", () => {
  it("shows members names and roles but no emails, and admins emails too", async () => {
    const [admin, member] = [await newUser("admin"), await newUser("member")];
    const org = await newOrg(admin, [[member, "member"]]);

    const asMember = await call(member, "GET", members(org.id));
    expect(asMember.statusCode).toBe(200);
    const memberView: { items: Record<string, unknown>[] } = asMember.json();
    expect(memberView.items.map((m) => [m["userId"], m["name"], m["role"]])).toEqual(
      expect.arrayContaining([
        [admin.id, "User admin", "admin"],
        [member.id, "User member", "member"],
      ]),
    );
    for (const item of memberView.items) expect(item).not.toHaveProperty("email");
    expect(JSON.stringify(asMember.json())).not.toContain("@example.com");

    const asAdmin = await call(admin, "GET", members(org.id));
    const emails = asAdmin.json().items.map((m: { email: string }) => m.email);
    expect(emails).toEqual(expect.arrayContaining([admin.email, member.email]));
  });

  it("pages through members without gaps or repeats, and rejects bad limits and cursors", async () => {
    const admin = await newUser("pager");
    const others = await Promise.all([1, 2, 3, 4].map((i) => newUser(`p${i}`)));
    const org = await newOrg(
      admin,
      others.map((u) => [u, "member"]),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await call(
        admin,
        "GET",
        `${members(org.id)}?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(res.statusCode).toBe(200);
      const page: { items: { userId: string }[]; nextCursor: string | null } = res.json();
      seen.push(...page.items.map((m) => m.userId));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
    expect(pages).toBe(3);

    for (const query of ["limit=0", "limit=101", "cursor=garbage"]) {
      expect((await call(admin, "GET", `${members(org.id)}?${query}`)).statusCode).toBe(400);
    }
  });
});

describe("authorization", () => {
  it("gives a member 403 on every admin-only route and changes nothing", async () => {
    const [admin, member, peer] = [await newUser("a"), await newUser("m"), await newUser("peer")];
    const org = await newOrg(admin, [
      [member, "member"],
      [peer, "member"],
    ]);

    const attempts = [
      await call(member, "PATCH", members(org.id, peer.id), { role: "admin" }),
      await call(member, "PATCH", members(org.id, member.id), { role: "admin" }),
      await call(member, "PATCH", members(org.id, admin.id), { role: "member" }),
      await call(member, "DELETE", members(org.id, peer.id)),
      await call(member, "DELETE", members(org.id, admin.id)),
    ];
    for (const res of attempts) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ type: "urn:sentra:error:forbidden", title: "Forbidden" });
    }
    expect(await roleOf(org.id, member.id)).toBe("member");
    expect(await roleOf(org.id, peer.id)).toBe("member");
    expect(await roleOf(org.id, admin.id)).toBe("admin");
    expect(await audit(org.id, "member.role_changed")).toHaveLength(0);
    expect(await audit(org.id, "member.removed")).toHaveLength(0);
    expect(logLines.some((l) => l["message"] === "role_denied" && l["userId"] === member.id)).toBe(
      true,
    );
  });

  it("answers a non-member exactly as it answers a nonexistent org, on every member route", async () => {
    const [admin, member, intruder] = [
      await newUser("owner"),
      await newUser("inside"),
      await newUser("outside"),
    ];
    const org = await newOrg(admin, [[member, "member"]]);
    const ghost = randomUUID();

    const normalize = (r: Awaited<ReturnType<typeof call>>) => ({
      status: r.statusCode,
      body: { ...r.json(), correlationId: "x" },
    });
    const probes: [Parameters<typeof call>[1], (orgId: string) => string, object?][] = [
      ["GET", (id) => members(id)],
      ["PATCH", (id) => members(id, member.id), { role: "admin" }],
      ["DELETE", (id) => members(id, member.id)],
      ["DELETE", (id) => members(id, intruder.id)],
    ];
    for (const [method, url, payload] of probes) {
      const missing = normalize(await call(intruder, method, url(ghost), payload));
      expect(missing.status).toBe(404);
      expect(normalize(await call(intruder, method, url(org.id), payload))).toEqual(missing);
      expect(normalize(await call(intruder, method, url("not-a-uuid"), payload))).toEqual(missing);
    }
    expect(await roleOf(org.id, member.id)).toBe("member");
    expect(JSON.stringify(logLines.filter((l) => l["userId"] === intruder.id))).not.toContain(
      member.id,
    );
  });

  it("requires authentication", async () => {
    const id = randomUUID();
    for (const method of ["GET", "PATCH", "DELETE"] as const) {
      const url = method === "GET" ? members(id) : members(id, id);
      expect((await call(null, method, url)).statusCode).toBe(401);
    }
  });

  it("ignores tenant and role fields in the body; the route decides", async () => {
    const [admin, member] = [await newUser("fa"), await newUser("fm")];
    const org = await newOrg(admin, [[member, "member"]]);
    const other = await newOrg(await newUser("someone-else"));

    const res = await call(admin, "PATCH", members(org.id, member.id), {
      role: "admin",
      orgId: other.id,
      userId: admin.id,
      callerRole: "admin",
    });
    expect(res.statusCode).toBe(200);
    expect(await roleOf(org.id, member.id)).toBe("admin");
    expect(await roleOf(other.id, member.id)).toBeUndefined();
  });

  it("applies a role change on the next request: a demoted admin loses admin rights", async () => {
    const [a, b] = [await newUser("first"), await newUser("second")];
    const org = await newOrg(a, [[b, "admin"]]);
    expect((await call(a, "PATCH", members(org.id, b.id), { role: "member" })).statusCode).toBe(
      200,
    );
    expect((await call(b, "PATCH", members(org.id, a.id), { role: "member" })).statusCode).toBe(
      403,
    );
    expect(await roleOf(org.id, a.id)).toBe("admin");
  });
});

describe("changing roles", () => {
  it("changes the role and records who changed what, atomically", async () => {
    const [admin, member] = [await newUser("ra"), await newUser("rm")];
    const org = await newOrg(admin, [[member, "member"]]);
    const res = await call(admin, "PATCH", members(org.id, member.id), { role: "admin" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userId: member.id, role: "admin", email: member.email });

    const events = await audit(org.id, "member.role_changed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_user_id: admin.id,
      target_type: "user",
      target_id: member.id,
      metadata: { from: "member", to: "admin" },
      correlation_id: res.headers["x-correlation-id"],
    });
  });

  it("treats setting the current role as a no-op with no extra audit event", async () => {
    const [admin, member] = [await newUser("na"), await newUser("nm")];
    const org = await newOrg(admin, [[member, "member"]]);
    for (let i = 0; i < 3; i++) {
      const res = await call(admin, "PATCH", members(org.id, member.id), { role: "member" });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe("member");
    }
    expect(await audit(org.id, "member.role_changed")).toHaveLength(0);
  });

  it("rejects invalid roles and unknown targets, including users of another org", async () => {
    const [admin, member, outsider] = [
      await newUser("va"),
      await newUser("vm"),
      await newUser("vo"),
    ];
    const org = await newOrg(admin, [[member, "member"]]);
    await newOrg(outsider);

    for (const payload of [{}, { role: "owner" }, { role: "ADMIN" }, { role: 1 }]) {
      const res = await call(admin, "PATCH", members(org.id, member.id), payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe("urn:sentra:error:invalid_input");
    }
    for (const target of [randomUUID(), outsider.id, "not-a-uuid"]) {
      expect(
        (await call(admin, "PATCH", members(org.id, target), { role: "admin" })).statusCode,
      ).toBe(404);
    }
    expect(await roleOf(org.id, member.id)).toBe("member");
  });

  it("rolls the change back when the audit insert fails", async () => {
    const [admin, member] = [await newUser("fa2"), await newUser("fm2")];
    const org = await newOrg(admin, [[member, "member"]]);
    await pool.query(`CREATE OR REPLACE FUNCTION fail_member_audit() RETURNS trigger AS $$
      BEGIN IF NEW.correlation_id = 'force-fail' THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await pool.query(
      "CREATE TRIGGER fail_member_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_member_audit()",
    );
    try {
      const res = await app.inject({
        method: "PATCH",
        url: members(org.id, member.id),
        headers: { ...admin.headers, "x-correlation-id": "force-fail" },
        payload: { role: "admin" },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await pool.query("DROP TRIGGER fail_member_audit ON audit_events");
      await pool.query("DROP FUNCTION fail_member_audit()");
    }
    expect(await roleOf(org.id, member.id)).toBe("member");
  });
});

describe("removing members and leaving", () => {
  it("removes a member, audits it once, and is idempotent on retry", async () => {
    const [admin, member] = [await newUser("da"), await newUser("dm")];
    const org = await newOrg(admin, [[member, "member"]]);
    expect((await call(member, "GET", members(org.id))).statusCode).toBe(200);

    for (let i = 0; i < 3; i++) {
      const res = await call(admin, "DELETE", members(org.id, member.id));
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
    }
    expect(await roleOf(org.id, member.id)).toBeUndefined();
    const events = await audit(org.id, "member.removed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_user_id: admin.id, target_id: member.id });

    // Access ends immediately.
    expect((await call(member, "GET", members(org.id))).statusCode).toBe(404);
  });

  it("answers 204 identically for anyone who is not a member, writing nothing", async () => {
    const [admin, outsider] = [await newUser("ia"), await newUser("io")];
    const org = await newOrg(admin);
    const otherOrg = await newOrg(outsider);
    const before = await pool.query("SELECT count(*)::int AS n FROM audit_events");

    for (const target of [randomUUID(), outsider.id, "not-a-uuid"]) {
      const res = await call(admin, "DELETE", members(org.id, target));
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
    }
    expect(await roleOf(otherOrg.id, outsider.id)).toBe("admin");
    const after = await pool.query("SELECT count(*)::int AS n FROM audit_events");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("lets a member leave, audits member.left, and answers 404 to a repeated leave", async () => {
    const [admin, member] = [await newUser("la"), await newUser("lm")];
    const org = await newOrg(admin, [[member, "member"]]);
    const res = await call(member, "DELETE", members(org.id, member.id));
    expect(res.statusCode).toBe(204);
    expect(await roleOf(org.id, member.id)).toBeUndefined();
    const events = await audit(org.id, "member.left");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_user_id: member.id, target_id: member.id });

    expect((await call(member, "DELETE", members(org.id, member.id))).statusCode).toBe(404);
    expect(await audit(org.id, "member.left")).toHaveLength(1);
  });
});

describe("the last admin", () => {
  it("cannot be demoted, removed, or leave, and nothing is audited", async () => {
    const [admin, member] = [await newUser("sole"), await newUser("plain")];
    const org = await newOrg(admin, [[member, "member"]]);
    for (const res of [
      await call(admin, "PATCH", members(org.id, admin.id), { role: "member" }),
      await call(admin, "DELETE", members(org.id, admin.id)),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().type).toBe("urn:sentra:error:last_admin");
    }
    expect(await roleOf(org.id, admin.id)).toBe("admin");
    expect(await audit(org.id, "member.role_changed")).toHaveLength(0);
    expect(await audit(org.id, "member.left")).toHaveLength(0);
  });

  it("lets an admin demote themself or leave while another admin remains", async () => {
    const [a, b] = [await newUser("pair-a"), await newUser("pair-b")];
    const org = await newOrg(a, [[b, "admin"]]);
    expect((await call(a, "PATCH", members(org.id, a.id), { role: "member" })).statusCode).toBe(
      200,
    );
    expect((await call(b, "DELETE", members(org.id, b.id))).statusCode).toBe(409);
    expect(await adminCount(org.id)).toBe(1);
  });

  it("keeps one admin when two admins demote each other at once", async () => {
    for (let round = 0; round < 5; round++) {
      const [a, b] = [await newUser(`dm-a${round}`), await newUser(`dm-b${round}`)];
      const org = await newOrg(a, [[b, "admin"]]);
      const results = await Promise.all([
        call(a, "PATCH", members(org.id, b.id), { role: "member" }),
        call(b, "PATCH", members(org.id, a.id), { role: "member" }),
      ]);
      // The loser was demoted first, so it no longer has the right to demote anyone.
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403]);
      expect(await adminCount(org.id)).toBe(1);
    }
  });

  it("keeps one admin when two admins leave at once", async () => {
    for (let round = 0; round < 5; round++) {
      const [a, b] = [await newUser(`lv-a${round}`), await newUser(`lv-b${round}`)];
      const org = await newOrg(a, [[b, "admin"]]);
      const results = await Promise.all([
        call(a, "DELETE", members(org.id, a.id)),
        call(b, "DELETE", members(org.id, b.id)),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([204, 409]);
      expect(await adminCount(org.id)).toBe(1);
    }
  });

  it("keeps one admin when one admin removes the other while that admin leaves", async () => {
    const [a, b] = [await newUser("rl-a"), await newUser("rl-b")];
    const org = await newOrg(a, [[b, "admin"]]);
    const results = await Promise.all([
      call(a, "DELETE", members(org.id, b.id)),
      call(b, "DELETE", members(org.id, b.id)),
    ]);
    // Both delete b: one removes the row, the other finds nothing left to remove.
    expect(results.map((r) => r.statusCode)).toEqual([204, 204]);
    expect(await adminCount(org.id)).toBe(1);
    expect(
      (await audit(org.id, "member.removed").then((e) => e.length)) +
        (await audit(org.id, "member.left")).length,
    ).toBe(1);
  });
});

describe("observability", () => {
  it("counts membership changes, rejections and role denials", async () => {
    const [admin, member] = [await newUser("oa"), await newUser("om")];
    const org = await newOrg(admin, [[member, "member"]]);
    await call(member, "PATCH", members(org.id, admin.id), { role: "member" });
    await call(admin, "PATCH", members(org.id, admin.id), { role: "member" });
    await call(admin, "PATCH", members(org.id, member.id), { role: "admin" });
    await call(admin, "DELETE", members(org.id, member.id));

    const text = (await app.inject({ method: "GET", url: "/metrics" })).body;
    expect(text).toContain("role_denied_total");
    expect(text).toContain('membership_change_rejected_total{reason="last_admin"}');
    expect(text).toContain('membership_changes_total{action="role_changed"}');
    expect(text).toContain('membership_changes_total{action="removed"}');
    expect(logLines.some((l) => l["message"] === "member_removed" && l["orgId"] === org.id)).toBe(
      true,
    );
  });
});
