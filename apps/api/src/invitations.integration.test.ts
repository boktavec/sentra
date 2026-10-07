// Real Postgres, real app routes. Two things are faked at the outer boundary: identity (see
// orgs.integration.test.ts) and Zitadel's userinfo endpoint, which is a third-party network call.
// The fake maps the caller's bearer token to a profile; the Playwright test exercises the real
// endpoint. Needs `task stack:up`. Run with `task api:test:integration`.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger, unauthenticated, unavailable } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createInvitationStore } from "./invitations.ts";
import { createMemberStore } from "./members.ts";
import { migrate } from "./migrate.ts";
import { createOrgStore, type Role } from "./orgs.ts";
import type { Profile } from "./profile.ts";
import { createUserStore } from "./users.ts";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required (see `task api:test:integration`)");

const LIMITS = { ttlHours: 168, maxPending: 3, maxPerDay: 6, maxMembers: 4 };

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
const profiles = new Map<string, Profile>();
let profileDown = false;

interface TestUser {
  id: string;
  email: string;
  headers: Record<string, string>;
}

/** A real user row. The fake userinfo reports `verified` and `email` for their bearer token. */
async function newUser(label: string, options: { verified?: boolean } = {}): Promise<TestUser> {
  const email = `${label}-${run}@example.com`;
  const user = await createUserStore(pool).resolve({
    issuer: "http://invitations.test",
    subject: randomUUID(),
  });
  profiles.set(user.id, { email, emailVerified: options.verified ?? true });
  return {
    id: user.id,
    email,
    headers: { "x-test-user": user.id, authorization: `Bearer ${user.id}` },
  };
}

async function newOrg(admin: TestUser, members: [TestUser, Role][] = []) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/orgs",
    headers: admin.headers,
    payload: { name: "Team", slug: `inv-${randomUUID().slice(0, 12)}` },
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
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: object,
) => app.inject({ method, url, headers: who?.headers ?? {}, payload });
const invite = (who: TestUser, orgId: string, email: string, role: Role = "member") =>
  call(who, "POST", `/v1/orgs/${orgId}/invitations`, { email, role });
const accept = (who: TestUser | null, token: unknown) =>
  call(who, "POST", "/v1/invitations/accept", { token } as object);
const invitationsPath = (orgId: string, id?: string) =>
  `/v1/orgs/${orgId}/invitations${id ? `/${id}` : ""}`;

const roleOf = async (orgId: string, userId: string) =>
  (
    await pool.query("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2", [
      orgId,
      userId,
    ])
  ).rows[0]?.role;
const memberCount = async (orgId: string) =>
  (await pool.query("SELECT count(*)::int AS n FROM memberships WHERE org_id = $1", [orgId]))
    .rows[0].n;
const audit = async (orgId: string, action: string) =>
  (
    await pool.query("SELECT * FROM audit_events WHERE org_id = $1 AND action = $2", [
      orgId,
      action,
    ])
  ).rows;
const statusOf = async (id: string) =>
  (await pool.query("SELECT status FROM invitations WHERE id = $1", [id])).rows[0].status;

/** Invites `invitee`'s email as `role` and returns what accepting needs. */
async function invitation(
  admin: TestUser,
  orgId: string,
  invitee: TestUser,
  role: Role = "member",
) {
  const res = await invite(admin, orgId, invitee.email, role);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 20 });
  await migrate(pool);
  const userStore = createUserStore(pool);
  app = buildApp({
    logger,
    orgs: createOrgStore(pool, { maxOrgsPerUser: 100 }),
    members: createMemberStore(pool),
    invitations: createInvitationStore(pool, {
      limits: LIMITS,
      fetchProfile: async (token) => {
        if (profileDown) throw unavailable("profile_fetch_failed");
        return profiles.get(token) ?? { emailVerified: false };
      },
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
beforeEach(() => {
  profileDown = false;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("creating and managing invitations", () => {
  it("creates an invitation, stores only the token's hash, and audits it without the email", async () => {
    const [admin, invitee] = [await newUser("c-admin"), await newUser("c-invitee")];
    const org = await newOrg(admin);
    const res = await invite(admin, org.id, `  ${invitee.email.toUpperCase()} `, "admin");
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ email: invitee.email, role: "admin" });
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const { rows } = await pool.query("SELECT * FROM invitations WHERE id = $1", [body.id]);
    expect(rows[0].status).toBe("pending");
    expect(JSON.stringify(rows[0])).not.toContain(body.token);
    expect(rows[0].expires_at.getTime() - rows[0].created_at.getTime()).toBeCloseTo(
      LIMITS.ttlHours * 3600_000,
      -4,
    );

    const events = await audit(org.id, "invitation.created");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_user_id: admin.id,
      target_type: "invitation",
      target_id: body.id,
      metadata: { role: "admin" },
    });
    expect(JSON.stringify(events[0])).not.toContain(invitee.email);
    expect(JSON.stringify(events[0])).not.toContain(body.token);
  });

  it("lists pending invitations without tokens and revokes them idempotently", async () => {
    const [admin, a, b] = [await newUser("l-admin"), await newUser("l-a"), await newUser("l-b")];
    const org = await newOrg(admin);
    const [first] = [await invitation(admin, org.id, a), await invitation(admin, org.id, b)];

    const listed = await call(admin, "GET", invitationsPath(org.id));
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((i: { email: string }) => i.email)).toEqual([a.email, b.email]);
    expect(JSON.stringify(listed.json())).not.toContain(first.token);

    for (let i = 0; i < 3; i++) {
      expect((await call(admin, "DELETE", invitationsPath(org.id, first.id))).statusCode).toBe(204);
    }
    expect(await statusOf(first.id)).toBe("revoked");
    expect(await audit(org.id, "invitation.revoked")).toHaveLength(1);
    expect((await call(admin, "GET", invitationsPath(org.id))).json().items).toHaveLength(1);
    for (const id of [randomUUID(), "not-a-uuid"]) {
      expect((await call(admin, "DELETE", invitationsPath(org.id, id))).statusCode).toBe(204);
    }
  });

  it("does not let an admin revoke another org's invitation", async () => {
    const [admin, other, invitee] = [
      await newUser("x-admin"),
      await newUser("x-other"),
      await newUser("x-invitee"),
    ];
    const org = await newOrg(admin);
    const otherOrg = await newOrg(other);
    const foreign = await invitation(admin, org.id, invitee);
    expect((await call(other, "DELETE", invitationsPath(otherOrg.id, foreign.id))).statusCode).toBe(
      204,
    );
    expect(await statusOf(foreign.id)).toBe("pending");
  });

  it("rejects invalid emails and roles", async () => {
    const admin = await newUser("v-admin");
    const org = await newOrg(admin);
    for (const payload of [
      {},
      { role: "member" },
      { email: "nope", role: "member" },
      { email: "a@b", role: "member" },
      { email: "a b@c.com", role: "member" },
      { email: `${"x".repeat(250)}@c.com`, role: "member" },
      { email: "a@b.com", role: "owner" },
      { email: "a@b.com" },
    ]) {
      const res = await call(admin, "POST", invitationsPath(org.id), payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe("urn:sentra:error:invalid_input");
    }
  });

  it("replaces an earlier invitation for the same email: the old token stops working", async () => {
    const [admin, invitee] = [await newUser("r-admin"), await newUser("r-invitee")];
    const org = await newOrg(admin);
    const old = await invitation(admin, org.id, invitee, "member");
    const fresh = await invitation(admin, org.id, invitee, "admin");

    expect(await statusOf(old.id)).toBe("revoked");
    expect((await audit(org.id, "invitation.revoked"))[0].metadata).toEqual({
      role: "member",
      reason: "replaced",
    });
    expect((await call(admin, "GET", invitationsPath(org.id))).json().items).toHaveLength(1);
    expect((await accept(invitee, old.token)).statusCode).toBe(410);
    const res = await accept(invitee, fresh.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("admin");
  });
});

describe("authorization", () => {
  it("gives a member 403 on every invitation route and changes nothing", async () => {
    const [admin, member, invitee] = [
      await newUser("a-admin"),
      await newUser("a-member"),
      await newUser("a-invitee"),
    ];
    const org = await newOrg(admin, [[member, "member"]]);
    const existing = await invitation(admin, org.id, invitee);

    for (const res of [
      await invite(member, org.id, "someone@example.com"),
      await call(member, "GET", invitationsPath(org.id)),
      await call(member, "DELETE", invitationsPath(org.id, existing.id)),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().type).toBe("urn:sentra:error:forbidden");
    }
    expect(await statusOf(existing.id)).toBe("pending");
    expect(await audit(org.id, "invitation.created")).toHaveLength(1);
  });

  it("answers a non-member exactly as it answers a nonexistent org", async () => {
    const [admin, outsider] = [await newUser("n-admin"), await newUser("n-outsider")];
    const org = await newOrg(admin);
    const existing = await invitation(admin, org.id, await newUser("n-invitee"));
    const normalize = (r: Awaited<ReturnType<typeof call>>) => ({
      status: r.statusCode,
      body: { ...r.json(), correlationId: "x" },
    });

    const probes: [Parameters<typeof call>[1], (id: string) => string, object?][] = [
      ["POST", (id) => invitationsPath(id), { email: "a@b.com", role: "member" }],
      ["GET", (id) => invitationsPath(id)],
      ["DELETE", (id) => invitationsPath(id, existing.id)],
    ];
    for (const [method, url, payload] of probes) {
      const missing = normalize(await call(outsider, method, url(randomUUID()), payload));
      expect(missing.status).toBe(404);
      expect(normalize(await call(outsider, method, url(org.id), payload))).toEqual(missing);
    }
    expect(await statusOf(existing.id)).toBe("pending");
  });

  it("requires authentication on every route", async () => {
    const id = randomUUID();
    expect((await call(null, "POST", invitationsPath(id), {})).statusCode).toBe(401);
    expect((await call(null, "GET", invitationsPath(id))).statusCode).toBe(401);
    expect((await call(null, "DELETE", invitationsPath(id, id))).statusCode).toBe(401);
    expect((await accept(null, "x".repeat(43))).statusCode).toBe(401);
  });
});

describe("limits", () => {
  it("refuses invitations past the pending cap, even when sent in parallel", async () => {
    const admin = await newUser("p-admin");
    const org = await newOrg(admin);
    const results = await Promise.all(
      Array.from({ length: LIMITS.maxPending + 3 }, (_, i) =>
        invite(admin, org.id, `p${i}-${run}@example.com`),
      ),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(LIMITS.maxPending);
    expect(statuses.filter((s) => s === 403)).toHaveLength(3);
    expect(results.find((r) => r.statusCode === 403)!.json().type).toBe(
      "urn:sentra:error:invitation_limit_reached",
    );
    expect((await call(admin, "GET", invitationsPath(org.id))).json().items).toHaveLength(
      LIMITS.maxPending,
    );
  });

  it("refuses invitations past the daily cap, even when revoking and re-inviting", async () => {
    const admin = await newUser("d-admin");
    const org = await newOrg(admin);
    for (let i = 0; i < LIMITS.maxPerDay; i++) {
      expect((await invite(admin, org.id, `same-${run}@example.com`)).statusCode).toBe(201);
    }
    const res = await invite(admin, org.id, `same-${run}@example.com`);
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe("urn:sentra:error:invitation_limit_reached");
  });

  it("does not count expired invitations as pending", async () => {
    const admin = await newUser("e-admin");
    const org = await newOrg(admin);
    for (let i = 0; i < LIMITS.maxPending; i++)
      await invite(admin, org.id, `e${i}-${run}@example.com`);
    await pool.query(
      "UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE org_id = $1",
      [org.id],
    );
    expect((await invite(admin, org.id, `fresh-${run}@example.com`)).statusCode).toBe(201);
    expect((await call(admin, "GET", invitationsPath(org.id))).json().items).toHaveLength(1);
  });

  it("refuses to accept into an org at the member cap and keeps the invitation usable", async () => {
    const [admin, invitee] = [await newUser("m-admin"), await newUser("m-invitee")];
    const fillers = await Promise.all([1, 2, 3].map((i) => newUser(`m-fill${i}`)));
    const org = await newOrg(
      admin,
      fillers.map((u) => [u, "member"]),
    );
    expect(await memberCount(org.id)).toBe(LIMITS.maxMembers);
    const sent = await invitation(admin, org.id, invitee);

    const res = await accept(invitee, sent.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe("urn:sentra:error:member_limit_reached");
    expect(await statusOf(sent.id)).toBe("pending");
    expect(await roleOf(org.id, invitee.id)).toBeUndefined();

    await call(admin, "DELETE", `/v1/orgs/${org.id}/members/${fillers[0]!.id}`);
    expect((await accept(invitee, sent.token)).statusCode).toBe(200);
  });
});

describe("accepting", () => {
  it("adds the invitee with the invited role, marks it used and audits it once", async () => {
    const [admin, invitee] = [await newUser("ok-admin"), await newUser("ok-invitee")];
    const org = await newOrg(admin);
    const sent = await invitation(admin, org.id, invitee, "admin");

    const res = await accept(invitee, sent.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: org.id, slug: org.slug, role: "admin" });
    expect(await roleOf(org.id, invitee.id)).toBe("admin");
    expect(await statusOf(sent.id)).toBe("accepted");
    const events = await audit(org.id, "invitation.accepted");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_user_id: invitee.id,
      target_id: sent.id,
      metadata: { role: "admin" },
      correlation_id: res.headers["x-correlation-id"],
    });
    // The new member can use the org straight away.
    expect((await call(invitee, "GET", `/v1/orgs/${org.id}/members`)).statusCode).toBe(200);
  });

  it("refuses a different or unverified email, leaves it usable, and reveals nothing about the org", async () => {
    const [admin, invitee, other, unverified] = [
      await newUser("w-admin"),
      await newUser("w-invitee"),
      await newUser("w-other"),
      await newUser("w-unverified", { verified: false }),
    ];
    const org = await newOrg(admin);
    const sent = await invitation(admin, org.id, invitee);
    // Same address, but the identity provider says it is not verified.
    profiles.set(unverified.id, { email: invitee.email, emailVerified: false });

    for (const who of [other, unverified]) {
      const res = await accept(who, sent.token);
      expect(res.statusCode).toBe(403);
      expect(res.json().type).toBe("urn:sentra:error:invitation_email_mismatch");
      expect(JSON.stringify(res.json())).not.toMatch(
        new RegExp(`${org.slug}|${invitee.email}|Team`),
      );
      expect(await roleOf(org.id, who.id)).toBeUndefined();
    }
    expect(await statusOf(sent.id)).toBe("pending");
    expect((await accept(invitee, sent.token)).statusCode).toBe(200);
  });

  it("refuses unknown, malformed, expired, revoked and already-used tokens", async () => {
    const [admin, invitee, other] = [
      await newUser("t-admin"),
      await newUser("t-invitee"),
      await newUser("t-other"),
    ];
    const org = await newOrg(admin);

    for (const token of [randomUUID(), "x".repeat(43), "", "a".repeat(500)]) {
      expect((await accept(invitee, token)).statusCode).toBe(404);
    }
    for (const token of [undefined, 1, null, ["a"]]) {
      expect((await accept(invitee, token)).statusCode).toBe(400);
    }

    const expired = await invitation(admin, org.id, invitee);
    await pool.query(
      "UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1",
      [expired.id],
    );
    const res = await accept(invitee, expired.token);
    expect(res.statusCode).toBe(410);
    expect(res.json().type).toBe("urn:sentra:error:invitation_expired");

    const revoked = await invitation(admin, org.id, other);
    await call(admin, "DELETE", invitationsPath(org.id, revoked.id));
    expect((await accept(other, revoked.token)).json().type).toBe(
      "urn:sentra:error:invitation_unavailable",
    );
    expect(await memberCount(org.id)).toBe(1);

    const used = await invitation(admin, org.id, other);
    expect((await accept(other, used.token)).statusCode).toBe(200);
    profiles.set(invitee.id, { email: other.email, emailVerified: true });
    expect((await accept(invitee, used.token)).statusCode).toBe(410);
  });

  it("is idempotent for the same user, even in parallel: one membership, one audit event", async () => {
    const [admin, invitee] = [await newUser("i-admin"), await newUser("i-invitee")];
    const org = await newOrg(admin);
    const sent = await invitation(admin, org.id, invitee);

    const results = await Promise.all(Array.from({ length: 6 }, () => accept(invitee, sent.token)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
    expect(new Set(results.map((r) => r.json().id))).toEqual(new Set([org.id]));
    expect(await memberCount(org.id)).toBe(2);
    expect(await audit(org.id, "invitation.accepted")).toHaveLength(1);
    expect((await accept(invitee, sent.token)).statusCode).toBe(200);
  });

  it("lets only the matching user win when two users race for one token", async () => {
    const [admin, invitee, other] = [
      await newUser("race-admin"),
      await newUser("race-invitee"),
      await newUser("race-other"),
    ];
    const org = await newOrg(admin);
    const sent = await invitation(admin, org.id, invitee);
    const results = await Promise.all([accept(invitee, sent.token), accept(other, sent.token)]);
    // The loser gets 403 if it ran first (wrong email) or 410 if it ran after the winner (used).
    const [winner, loser] = results.map((r) => r.statusCode).sort();
    expect(winner).toBe(200);
    expect([403, 410]).toContain(loser);
    expect(results[1]!.statusCode).not.toBe(200);
    expect(await roleOf(org.id, other.id)).toBeUndefined();
    expect(await memberCount(org.id)).toBe(2);
  });

  it("keeps an existing member's role when they accept an invitation to the same org", async () => {
    const [admin, member] = [await newUser("k-admin"), await newUser("k-member")];
    const org = await newOrg(admin, [[member, "member"]]);
    const sent = await invitation(admin, org.id, member, "admin");
    const res = await accept(member, sent.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("member");
    expect(await memberCount(org.id)).toBe(2);
    expect((await audit(org.id, "invitation.accepted"))[0].metadata).toMatchObject({
      alreadyMember: "true",
    });
  });

  it("does not let a used invitation bring back someone who has since left", async () => {
    const [admin, invitee] = [await newUser("b-admin"), await newUser("b-invitee")];
    const org = await newOrg(admin);
    const sent = await invitation(admin, org.id, invitee);
    expect((await accept(invitee, sent.token)).statusCode).toBe(200);
    await call(invitee, "DELETE", `/v1/orgs/${org.id}/members/${invitee.id}`);
    expect((await accept(invitee, sent.token)).statusCode).toBe(410);
    expect(await roleOf(org.id, invitee.id)).toBeUndefined();
  });
});

describe("failures", () => {
  it("answers 503 and changes nothing when the identity provider is unavailable, and works on retry", async () => {
    const [admin, invitee] = [await newUser("f-admin"), await newUser("f-invitee")];
    const org = await newOrg(admin);
    const sent = await invitation(admin, org.id, invitee);

    profileDown = true;
    const res = await accept(invitee, sent.token);
    expect(res.statusCode).toBe(503);
    expect(await statusOf(sent.id)).toBe("pending");
    expect(await roleOf(org.id, invitee.id)).toBeUndefined();
    profileDown = false;
    expect((await accept(invitee, sent.token)).statusCode).toBe(200);
  });

  it("rolls everything back when the audit insert fails", async () => {
    const [admin, invitee] = [await newUser("rb-admin"), await newUser("rb-invitee")];
    const org = await newOrg(admin);
    const sent = await invitation(admin, org.id, invitee);
    await pool.query(`CREATE OR REPLACE FUNCTION fail_invitation_audit() RETURNS trigger AS $$
      BEGIN IF NEW.correlation_id = 'force-fail' THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await pool.query(
      "CREATE TRIGGER fail_invitation_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_invitation_audit()",
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: { ...invitee.headers, "x-correlation-id": "force-fail" },
        payload: { token: sent.token },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await pool.query("DROP TRIGGER fail_invitation_audit ON audit_events");
      await pool.query("DROP FUNCTION fail_invitation_audit()");
    }
    expect(await statusOf(sent.id)).toBe("pending");
    expect(await roleOf(org.id, invitee.id)).toBeUndefined();
    expect((await accept(invitee, sent.token)).statusCode).toBe(200);
  });
});

describe("secrets and observability", () => {
  it("never logs the token or the invited email, and counts outcomes", async () => {
    const [admin, invitee, other] = [
      await newUser("s-admin"),
      await newUser("s-invitee"),
      await newUser("s-other"),
    ];
    const org = await newOrg(admin);
    logLines.length = 0;
    const sent = await invitation(admin, org.id, invitee);
    await accept(other, sent.token);
    await accept(invitee, sent.token);
    await accept(invitee, "y".repeat(43));

    const logs = JSON.stringify(logLines);
    expect(logs).not.toContain(sent.token);
    expect(logs).not.toContain(invitee.email);
    expect(logs).not.toContain(other.email);
    expect(
      logLines.some((l) => l["message"] === "invitation_created" && l["orgId"] === org.id),
    ).toBe(true);
    expect(logLines.some((l) => l["message"] === "invitation_accepted")).toBe(true);

    const text = (await app.inject({ method: "GET", url: "/metrics" })).body;
    for (const name of ["created", "accepted", "mismatch", "unknown"]) {
      expect(text).toContain(`invitation_outcomes_total{outcome="${name}"}`);
    }
  });
});
