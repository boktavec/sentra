// Requires `task stack:up` and `task stack:bootstrap`. Run with `task api:test:integration`.
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@sentra/ts-platform";
import { createApi } from "./api.ts";
import { loadConfig, type Config } from "./config.ts";
import { createUserStore } from "./users.ts";

const config: Config = { ...loadConfig(), authFailLimit: 3, authFailWindowSeconds: 60 };
const logLines: Record<string, unknown>[] = [];
const logger = createLogger("api-test", {
  level: "info",
  destination: new Writable({
    write(chunk, _enc, done) {
      logLines.push(JSON.parse(chunk.toString()));
      done();
    },
  }),
});

async function realToken(): Promise<string> {
  const res = await fetch(`${config.issuer}/oauth/v2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${process.env["ZITADEL_TEST_CLIENT_ID"]}:${process.env["ZITADEL_TEST_CLIENT_SECRET"]}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "openid" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

let api: Awaited<ReturnType<typeof createApi>>;
let token: string;

const get = (headers: Record<string, string> = {}) =>
  api.app.inject({ method: "GET", url: "/v1/me", headers });

beforeAll(async () => {
  api = await createApi(config, logger);
  token = await realToken();
});
afterAll(() => api.close());
beforeEach(async () => {
  const keys = await api.redis.keys("authfail:*");
  if (keys.length) await api.redis.del(...keys);
  logLines.length = 0;
});

describe("authentication against real Zitadel, Redis and Postgres", () => {
  it("serves readiness once keys and the database are available", async () => {
    expect((await api.app.inject({ url: "/readyz" })).statusCode).toBe(200);
  });

  it("identifies the user from a real Zitadel JWT and provisions exactly one user row", async () => {
    const first = await get({ authorization: `Bearer ${token}` });
    const second = await get({ authorization: `Bearer ${token}` });
    expect(first.statusCode).toBe(200);
    const { id } = first.json();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.json().id).toBe(id);

    const { rows } = await api.pool.query("SELECT issuer, subject FROM users WHERE id = $1", [id]);
    expect(rows).toEqual([{ issuer: config.issuer, subject: expect.any(String) }]);
  });

  it("returns the same generic 401 for missing, malformed, and tampered tokens", async () => {
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Basic abc" },
      { authorization: `Bearer ${token}x` },
    ];
    for (const headers of attempts) {
      const res = await get(headers);
      expect(res.statusCode).toBe(401);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.json()).toEqual({
        type: "urn:sentra:error:unauthenticated",
        title: "Authentication required",
        status: 401,
        correlationId: res.headers["x-correlation-id"],
      });
    }
    const reasons = logLines.filter((l) => l["message"] === "auth_failure").map((l) => l["reason"]);
    expect(reasons).toEqual(["missing_token", "missing_token", "invalid_signature"]);
  });

  it("never logs the token", async () => {
    await get({ authorization: `Bearer ${token}` });
    await get({ authorization: `Bearer ${token}x` });
    expect(JSON.stringify(logLines)).not.toContain(token.slice(20, 60));
  });

  it("creates one user row when many first requests arrive concurrently", async () => {
    const claims = { issuer: "http://concurrency.test", subject: `sub-${Date.now()}` };
    const stores = Array.from({ length: 20 }, () => createUserStore(api.pool)); // empty caches: all hit the DB
    const users = await Promise.all(stores.map((s) => s.resolve(claims)));
    expect(new Set(users.map((u) => u.id)).size).toBe(1);
    const { rows } = await api.pool.query(
      "SELECT count(*)::int AS n FROM users WHERE subject = $1",
      [claims.subject],
    );
    expect(rows[0].n).toBe(1);
  });

  it("rate limits repeated auth failures per IP, ignoring a spoofed X-Forwarded-For", async () => {
    const statuses: number[] = [];
    let retryAfter: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await get({
        authorization: "Bearer bad.token.value",
        "x-forwarded-for": `10.0.0.${i}`,
      });
      statuses.push(res.statusCode);
      retryAfter = res.headers["retry-after"] as string | undefined;
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  });

  it("keeps serving valid tokens from an IP that is being rate limited", async () => {
    for (let i = 0; i < 5; i++) await get({ authorization: "Bearer bad.token.value" });
    expect((await get({ authorization: `Bearer ${token}` })).statusCode).toBe(200);
  });

  it("assigns correlation IDs, honoring only well-formed incoming ones", async () => {
    const kept = await api.app.inject({
      url: "/healthz",
      headers: { "x-correlation-id": "abc-123" },
    });
    expect(kept.headers["x-correlation-id"]).toBe("abc-123");
    const replaced = await api.app.inject({
      url: "/healthz",
      headers: { "x-correlation-id": 'bad id"' },
    });
    expect(replaced.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers unknown routes with the generic problem body", async () => {
    const res = await api.app.inject({ url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toBe("urn:sentra:error:not_found");
  });
});

describe("when Redis is unavailable", () => {
  it("fails open: auth still returns 401 / 200, never 429 or 500", async () => {
    const degraded = await createApi({ ...config, redisUrl: "redis://127.0.0.1:1" }, logger);
    try {
      for (let i = 0; i < 6; i++) {
        const res = await degraded.app.inject({
          url: "/v1/me",
          headers: { authorization: "Bearer bad.token.value" },
        });
        expect(res.statusCode).toBe(401);
      }
      const ok = await degraded.app.inject({
        url: "/v1/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(ok.statusCode).toBe(200);
      expect(logLines.some((l) => l["message"] === "rate_limiter_unavailable")).toBe(true);
    } finally {
      await degraded.close();
    }
  });
});
