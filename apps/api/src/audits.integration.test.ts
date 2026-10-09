import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, unauthenticated } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createAuditStore } from "./audits.ts";
import { createFindingStore } from "./findings.ts";
import { createInvitationStore } from "./invitations.ts";
import { createMemberStore } from "./members.ts";
import { migrate } from "./migrate.ts";
import { createOrgStore } from "./orgs.ts";
import { createProjectStore } from "./projects.ts";
import { createUserStore } from "./users.ts";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required (see `task api:test:integration`)");
const lines: Record<string, unknown>[] = [];
const logger = createLogger("api-test", {
  level: "debug",
  destination: new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()));
      done();
    },
  }),
});

let pool: Pool;
let app: ReturnType<typeof buildApp>;
const run = randomUUID().slice(0, 8);
const headers = (id: string) => ({ "x-test-user": id });

async function user() {
  return createUserStore(pool).resolve({ issuer: "http://audits.test", subject: randomUUID() });
}
async function org(userId: string, suffix: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/orgs",
    headers: headers(userId),
    payload: { name: suffix, slug: `audit-${suffix}-${run}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}
const get = (userId: string, orgId: string, query = "") =>
  app.inject({
    method: "GET",
    url: `/v1/orgs/${orgId}/audit-events${query}`,
    headers: headers(userId),
  });

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  await migrate(pool);
  const users = createUserStore(pool);
  app = buildApp({
    logger,
    audits: createAuditStore(pool, logger),
    orgs: createOrgStore(pool, { maxOrgsPerUser: 20 }),
    members: createMemberStore(pool),
    projects: createProjectStore(pool),
    findings: createFindingStore(pool),
    invitations: createInvitationStore(pool, {
      fetchProfile: async () => ({ emailVerified: false }),
      webUrl: "http://localhost:3000",
      limits: { ttlHours: 1, maxPending: 5, maxPerDay: 5, maxMembers: 5 },
    }),
    trustedProxies: false,
    ready: async () => true,
    authenticate: async (request) => {
      const id = request.headers["x-test-user" as "authorization"];
      if (typeof id !== "string") throw unauthenticated("missing_token");
      const { rows } = await pool.query("SELECT issuer, subject FROM users WHERE id = $1", [id]);
      return users.resolve(rows[0]);
    },
  });
  app.get("/test-error", () => {
    throw new Error("internal details must not reach the sanitized event");
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("audit history", () => {
  it("is admin-only, tenant-scoped, redacted, filtered, and keyset paged", async () => {
    const admin = await user();
    const member = await user();
    const other = await user();
    const own = await org(admin.id, "own");
    const foreign = await org(other.id, "foreign");
    await pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [
      own.id,
      member.id,
    ]);
    const timestamp = "2026-01-01T00:00:00.000Z";
    for (const action of ["first", "second", "third"]) {
      await pool.query(
        `INSERT INTO audit_events (org_id, actor_user_id, action, target_type, target_id, metadata, created_at)
         VALUES ($1, $2, $3, 'project', $4, '{"filename":"secret.json"}', $5)`,
        [own.id, admin.id, action, randomUUID(), timestamp],
      );
    }
    const first = await get(
      admin.id,
      own.id,
      "?limit=2&from=2025-12-31T00%3A00%3A00Z&to=2026-01-02T00%3A00%3A00Z",
    );
    expect(first.statusCode).toBe(200);
    expect(first.body).not.toContain("secret.json");
    expect(first.json().items).toHaveLength(2);
    const second = await get(
      admin.id,
      own.id,
      `?limit=2&from=2025-12-31T00%3A00%3A00Z&to=2026-01-02T00%3A00%3A00Z&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    );
    expect(second.json().items).toHaveLength(1);
    expect(
      new Set(
        [...first.json().items, ...second.json().items].map((item: { id: string }) => item.id),
      ).size,
    ).toBe(3);
    expect((await get(member.id, own.id)).statusCode).toBe(403);
    expect((await get(other.id, own.id)).statusCode).toBe(404);
    expect((await get(admin.id, foreign.id)).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/v1/orgs/${own.id}/audit-events` })).statusCode,
    ).toBe(401);
    expect(
      (await get(admin.id, own.id, "?from=2026-01-01T00%3A00%3A00Z&to=2026-01-01T00%3A00%3A00.1Z"))
        .statusCode,
    ).toBe(200);
    for (const query of [
      "?from=nope",
      "?from=2026-01-01T00%3A00%3A00.9Z&to=2026-01-01T00%3A00%3A00Z",
      "?from=2026-01-02T00%3A00%3A00Z&to=2026-01-01T00%3A00%3A00Z",
      "?actorId=nope",
      "?result=nope",
      "?cursor=bad",
    ]) {
      expect((await get(admin.id, own.id, query)).statusCode).toBe(400);
    }
    expect(
      (await get(admin.id, own.id, `?cursor=${encodeURIComponent(first.json().nextCursor)}`))
        .statusCode,
    ).toBe(400);
  });

  it("logs all failed requests and records a verified member's failed sensitive request without masking it", async () => {
    const admin = await user();
    const own = await org(admin.id, "failure");
    lines.length = 0;
    const failed = await app.inject({
      method: "POST",
      url: `/v1/orgs/${own.id}/projects`,
      headers: { ...headers(admin.id), "x-forwarded-for": "203.0.113.7" },
      payload: { name: "bad", slug: "Bad" },
    });
    expect(failed.statusCode).toBe(400);
    const events = await get(admin.id, own.id, "?result=failed&action=project.create");
    expect(events.json().items).toMatchObject([
      { result: "failed", failureCode: "invalid_input", targetId: null },
    ]);
    const failureLogs = lines.filter((line) => line.message === "api_request_failed");
    expect(failureLogs).toEqual([
      expect.objectContaining({
        status: 400,
        route: "/v1/orgs/:orgId/projects",
        failureCode: "invalid_input",
      }),
    ]);
    expect(failureLogs[0]?.requestIp).not.toBe("203.0.113.7");
    expect(JSON.stringify(failureLogs)).not.toContain("203.0.113.7");
    expect(JSON.stringify(lines)).not.toContain("Bad");

    await pool.query(`CREATE OR REPLACE FUNCTION fail_failed_audit() RETURNS trigger AS $$
      BEGIN IF NEW.result = 'failed' THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await pool.query(
      "CREATE TRIGGER fail_failed_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_failed_audit()",
    );
    try {
      const unavailable = await app.inject({
        method: "POST",
        url: `/v1/orgs/${own.id}/projects`,
        headers: headers(admin.id),
        payload: { name: "still bad", slug: "Bad" },
      });
      expect(unavailable.statusCode).toBe(400);
    } finally {
      await pool.query("DROP TRIGGER fail_failed_audit ON audit_events");
      await pool.query("DROP FUNCTION fail_failed_audit()");
    }
    expect(lines.some((line) => line.message === "tenant_audit_failure_recording_failed")).toBe(
      true,
    );
  });

  it("records a rejected self-leave as member.left, including for the last admin", async () => {
    const admin = await user();
    const own = await org(admin.id, "last-admin");
    const rejected = await app.inject({
      method: "DELETE",
      url: `/v1/orgs/${own.id}/members/${admin.id}`,
      headers: headers(admin.id),
    });
    expect(rejected.statusCode).toBe(409);

    const events = await get(admin.id, own.id, "?result=failed&action=member.left");
    expect(events.json().items).toMatchObject([
      { result: "failed", failureCode: "last_admin", targetId: null },
    ]);
    expect(
      (await get(admin.id, own.id, "?result=failed&action=member.removed")).json().items,
    ).toHaveLength(0);
  });

  it("emits exactly one sanitized failure log for 401, 403, 404, and 500 responses", async () => {
    const admin = await user();
    const member = await user();
    const outsider = await user();
    const own = await org(admin.id, "failure-statuses");
    await pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [
      own.id,
      member.id,
    ]);
    const check = async (
      status: number,
      route: string,
      request: Promise<{ statusCode: number }>,
      secret: string,
    ) => {
      lines.length = 0;
      expect((await request).statusCode).toBe(status);
      const events = lines.filter((line) => line.message === "api_request_failed");
      expect(events).toEqual([expect.objectContaining({ status, route })]);
      expect(JSON.stringify(events)).not.toContain(secret);
    };

    await check(
      401,
      "/v1/me",
      app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer secret" } }),
      "Bearer secret",
    );
    await check(403, "/v1/orgs/:orgId/audit-events", get(member.id, own.id), "role_denied");
    await check(
      404,
      "/v1/orgs/:orgId/audit-events",
      get(outsider.id, own.id, "?token=not-for-logs"),
      "not-for-logs",
    );
    await check(
      500,
      "/test-error",
      app.inject({ method: "GET", url: "/test-error" }),
      "internal details",
    );
  });
});
