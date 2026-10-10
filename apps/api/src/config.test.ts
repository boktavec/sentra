import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.ts";

const key = () => randomBytes(32).toString("base64");

beforeEach(() => {
  vi.stubEnv("ZITADEL_ISSUER", "http://issuer.test");
  vi.stubEnv("AUTH_AUDIENCES", "aud");
  vi.stubEnv("DATABASE_URL", "postgres://x");
  vi.stubEnv("REDIS_URL", "redis://x");
  vi.stubEnv("INTELLIGENCE_TOOL_TOKEN", "t".repeat(32));
  vi.stubEnv("INVESTIGATION_TOOL_SIGNING_KEYS", `k1:${key()}`);
});
afterEach(() => vi.unstubAllEnvs());

describe("investigation tool listener config", () => {
  it("defaults to loopback port 4001 and reads the secret and keys", () => {
    const { investigationTools } = loadConfig();
    expect(investigationTools).toMatchObject({ host: "127.0.0.1", port: 4001 });
    expect(investigationTools.signingKeys.map((k) => k.kid)).toEqual(["k1"]);
  });

  it("refuses to start without the service secret or the signing keys", () => {
    vi.stubEnv("INTELLIGENCE_TOOL_TOKEN", "");
    expect(() => loadConfig()).toThrow(/INTELLIGENCE_TOOL_TOKEN/);
    vi.stubEnv("INTELLIGENCE_TOOL_TOKEN", "t".repeat(32));
    vi.stubEnv("INVESTIGATION_TOOL_SIGNING_KEYS", "");
    expect(() => loadConfig()).toThrow(/INVESTIGATION_TOOL_SIGNING_KEYS/);
  });

  it("refuses a short service secret or a short signing key", () => {
    vi.stubEnv("INTELLIGENCE_TOOL_TOKEN", "short");
    expect(() => loadConfig()).toThrow(/at least 32 bytes/);
    vi.stubEnv("INTELLIGENCE_TOOL_TOKEN", "t".repeat(32));
    vi.stubEnv("INVESTIGATION_TOOL_SIGNING_KEYS", `k1:${randomBytes(8).toString("base64")}`);
    expect(() => loadConfig()).toThrow(/at least 32 bytes/);
  });
});
