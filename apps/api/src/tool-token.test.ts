import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertSecretLength, parseSigningKeys, signToken, verifyToken } from "./tool-token.ts";

const material = () => randomBytes(32).toString("base64");
const claims = { inv: "inv-1", lease: "lease-1", exp: 2000 };

describe("parseSigningKeys", () => {
  it("reads kid:base64key pairs in order", () => {
    const keys = parseSigningKeys(`new:${material()},old:${material()}`);
    expect(keys.map((k) => k.kid)).toEqual(["new", "old"]);
  });

  it.each([
    ["no separator", "justakey"],
    ["empty kid", `:${material()}`],
    ["kid with a dot", `a.b:${material()}`],
    ["not base64", "k:not base64!"],
    ["too short", `k:${randomBytes(31).toString("base64")}`],
    ["duplicate kid", `k:${material()},k:${material()}`],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseSigningKeys(raw)).toThrow();
  });
});

describe("assertSecretLength", () => {
  it("requires at least 32 bytes", () => {
    expect(() => assertSecretLength("S", "x".repeat(31))).toThrow(/at least 32 bytes/);
    expect(() => assertSecretLength("S", "x".repeat(32))).not.toThrow();
  });
});

describe("signToken and verifyToken", () => {
  const keys = parseSigningKeys(`new:${material()},old:${material()}`);

  it("round-trips claims before expiry and rejects them from the expiry second on", () => {
    const token = signToken(keys, claims);
    expect(verifyToken(keys, token, 1999)).toEqual(claims);
    expect(verifyToken(keys, token, 2000)).toBeNull();
  });

  it("signs with the first key but still verifies tokens signed by a later key (rotation)", () => {
    expect(signToken(keys, claims).split(".")[1]).toBe("new");
    const oldOnly = signToken([keys[1]!], claims);
    expect(verifyToken(keys, oldOnly, 1)).toEqual(claims);
    expect(verifyToken([keys[0]!], oldOnly, 1)).toBeNull();
  });

  it("rejects a changed payload, signature, version, or key id", () => {
    const [version, kid, payload, signature] = signToken(keys, claims).split(".") as [
      string,
      string,
      string,
      string,
    ];
    const other = Buffer.from(JSON.stringify({ ...claims, inv: "inv-2" })).toString("base64url");
    for (const forged of [
      [version, kid, other, signature],
      [version, kid, payload, signature.slice(0, -2) + "AA"],
      [version, kid, payload, ""],
      ["v2", kid, payload, signature],
      [version, "old", payload, signature],
    ]) {
      expect(verifyToken(keys, forged.join("."), 1)).toBeNull();
    }
    expect(verifyToken(keys, "a.b.c", 1)).toBeNull();
    expect(verifyToken(keys, "", 1)).toBeNull();
  });

  it("rejects a correctly signed token whose claims are malformed", () => {
    const [{ key, kid }] = keys as [(typeof keys)[number]];
    const forge = (payload: string) => {
      const signed = `v1.${kid}.${Buffer.from(payload).toString("base64url")}`;
      return `${signed}.${createMac(key, signed)}`;
    };
    expect(verifyToken(keys, forge("not json"), 1)).toBeNull();
    expect(verifyToken(keys, forge('{"inv":1,"lease":"l","exp":9}'), 1)).toBeNull();
    expect(verifyToken(keys, forge('{"inv":"i","lease":"l"}'), 1)).toBeNull();
  });
});

import { createHmac } from "node:crypto";
const createMac = (key: Buffer, signed: string) =>
  createHmac("sha256", key).update(signed).digest("base64url");
