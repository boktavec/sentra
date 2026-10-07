import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@sentra/ts-platform";
import { JwksCache } from "./jwks.ts";
import { createVerifier } from "./verifier.ts";

const ISSUER = "http://issuer.test";
const AUDIENCE = "client-1";

interface Signer {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}

async function makeSigner(kid: string): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
}

const sign = (
  signer: Signer,
  claims: Record<string, unknown> = {},
  opts: { issuer?: string; audience?: string; expiresIn?: string } = {},
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: signer.kid })
    .setSubject("user-1")
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "5m")
    .sign(signer.privateKey);

/** A real HTTP server publishing a JWKS we can rotate, count hits on, and kill. */
function jwksServer() {
  let keys: JWK[] = [];
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits++;
    res.setHeader("content-type", "application/json").end(JSON.stringify({ keys }));
  });
  return {
    start: () =>
      new Promise<string>((resolve) =>
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/keys`),
        ),
      ),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    publish: (...next: Signer[]) => {
      keys = next.map((s) => s.jwk);
    },
    hits: () => hits,
  };
}

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).reason;
}

describe("token verification against a JWKS endpoint", () => {
  const server = jwksServer();
  let url: string;
  let now = Date.now();
  let jwks: JwksCache;
  let verify: ReturnType<typeof createVerifier>;
  let key1: Signer;
  let refreshErrors: unknown[];

  beforeEach(async () => {
    key1 = await makeSigner("k1");
    server.publish(key1);
    url = await server.start();
    now = Date.now();
    refreshErrors = [];
    jwks = new JwksCache({
      url,
      cooldownMs: 60_000,
      maxAgeMs: 600_000,
      now: () => now,
      onRefreshError: (e) => refreshErrors.push(e),
    });
    verify = createVerifier({ issuer: ISSUER, audiences: [AUDIENCE, "client-2"], jwks });
    await jwks.warm();
  });
  afterEach(() => server.stop());

  it("accepts a valid token and exposes identity claims", async () => {
    const token = await sign(key1, { email: "a@example.com", name: "A" });
    expect(await verify(token)).toEqual({
      issuer: ISSUER,
      subject: "user-1",
      email: "a@example.com",
      name: "A",
    });
  });

  it("accepts any configured audience", async () => {
    expect((await verify(await sign(key1, {}, { audience: "client-2" }))).subject).toBe("user-1");
  });

  it.each([
    ["expired", { expiresIn: "-5m" }, "expired"],
    ["wrong issuer", { issuer: "http://evil.test" }, "unknown_issuer"],
    ["wrong audience", { audience: "someone-else" }, "wrong_audience"],
  ])("rejects %s", async (_name, opts, reason) => {
    expect(await reasonOf(verify(await sign(key1, {}, opts)))).toBe(reason);
  });

  it("rejects a token signed by a different key with the same kid", async () => {
    const impostor = await makeSigner("k1");
    expect(await reasonOf(verify(await sign(impostor)))).toBe("invalid_signature");
  });

  it("rejects a tampered payload", async () => {
    const [h, , s] = (await sign(key1)).split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "admin", iss: ISSUER, aud: AUDIENCE, exp: 9999999999 }),
    ).toString("base64url");
    expect(await reasonOf(verify(`${h}.${forged}.${s}`))).toBe("invalid_signature");
  });

  it("rejects alg=none and non-RS256 tokens", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "u", iss: ISSUER, aud: AUDIENCE, exp: 9999999999 }),
    ).toString("base64url");
    expect(await reasonOf(verify(`${header}.${payload}.`))).toBe("invalid_token");
    expect(await reasonOf(verify("not-a-jwt"))).toBe("invalid_token");
  });

  it("verifies known keys without any network call", async () => {
    const before = server.hits();
    for (let i = 0; i < 5; i++) await verify(await sign(key1));
    expect(server.hits()).toBe(before);
  });

  it("picks up a rotated key via one refresh, then throttles refreshes for unknown kids", async () => {
    const key2 = await makeSigner("k2");
    server.publish(key1, key2);
    now += 61_000; // past the cooldown
    const before = server.hits();
    expect((await verify(await sign(key2))).subject).toBe("user-1");
    expect(server.hits()).toBe(before + 1);

    const attacker = await makeSigner("random-kid");
    for (let i = 0; i < 10; i++)
      expect(await reasonOf(verify(await sign(attacker)))).toBe("unknown_key");
    expect(server.hits()).toBe(before + 1); // all throttled inside the cooldown

    now += 61_000;
    expect(await reasonOf(verify(await sign(attacker)))).toBe("unknown_key");
    expect(await reasonOf(verify(await sign(attacker)))).toBe("unknown_key");
    expect(server.hits()).toBe(before + 2); // one refresh once the cooldown has passed
  });

  it("keeps verifying from cached keys when the JWKS endpoint goes down", async () => {
    await server.stop();
    now += 11 * 60_000; // keys are stale and a background refresh will be attempted
    expect((await verify(await sign(key1))).subject).toBe("user-1");
    await new Promise((r) => setTimeout(r, 50));
    expect(refreshErrors.length).toBeGreaterThan(0);
    expect((await verify(await sign(key1))).subject).toBe("user-1");
  });
});

describe("cold start without reachable signing keys", () => {
  it("reports not ready and answers 503 rather than 401", async () => {
    const errors: unknown[] = [];
    const jwks = new JwksCache({
      url: "http://127.0.0.1:1/keys",
      onRefreshError: (e) => errors.push(e),
    });
    await jwks.warm();
    expect(jwks.ready).toBe(false);
    expect(errors).toHaveLength(1);
    const verify = createVerifier({ issuer: ISSUER, audiences: [AUDIENCE], jwks });
    const key = await makeSigner("k1");
    const err = await verify(await sign(key)).catch((e: unknown) => e);
    expect((err as AppError).status).toBe(503);
  });
});
