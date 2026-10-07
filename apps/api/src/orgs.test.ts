import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, validateNewOrg, validateRole } from "./org-input.ts";

describe("validateNewOrg", () => {
  it("accepts a normal org and trims the name", () => {
    expect(validateNewOrg({ name: "  Acme Inc  ", slug: "acme-inc" })).toEqual({
      name: "Acme Inc",
      slug: "acme-inc",
    });
  });

  it.each([
    ["missing body", undefined],
    ["non-string fields", { name: 1, slug: "acme" }],
    ["empty name", { name: "   ", slug: "acme" }],
    ["name over 80 chars", { name: "x".repeat(81), slug: "acme" }],
    ["control character in name", { name: "Ac\u0000me", slug: "acme" }],
    ["slug too short", { name: "A", slug: "ab" }],
    ["slug too long", { name: "A", slug: "a".repeat(41) }],
    ["uppercase slug", { name: "A", slug: "Acme" }],
    ["leading hyphen", { name: "A", slug: "-acme" }],
    ["trailing hyphen", { name: "A", slug: "acme-" }],
    ["underscore", { name: "A", slug: "ac_me" }],
    ["reserved slug", { name: "A", slug: "settings" }],
  ])("rejects %s", (_label, body) => {
    expect(() => validateNewOrg(body)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("accepts the length boundaries", () => {
    expect(validateNewOrg({ name: "A", slug: "abc" }).slug).toBe("abc");
    expect(validateNewOrg({ name: "x".repeat(80), slug: "a".repeat(40) }).slug).toHaveLength(40);
  });
});

describe("cursor", () => {
  const orgId = "0b9d3b59-9a3b-4a53-9b0b-0d6a8f0f3c11";

  it("round-trips a microsecond timestamp unchanged", () => {
    const createdAt = "2026-10-07 12:34:56.123456+00";
    expect(decodeCursor(encodeCursor(createdAt, orgId))).toEqual({ createdAt, orgId });
  });

  it.each([
    ["not base64 json", "!!!"],
    ["wrong shape", Buffer.from('{"a":1}').toString("base64url")],
    ["bad timestamp", encodeCursor("yesterday", orgId)],
    ["bad uuid", encodeCursor("2026-10-07 12:34:56+00", "nope")],
  ])("rejects a tampered cursor: %s", (_label, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("validateRole", () => {
  it.each(["admin", "member"])("accepts %s", (role) => {
    expect(validateRole({ role })).toBe(role);
  });

  it.each([
    undefined,
    null,
    {},
    { role: "owner" },
    { role: "Admin" },
    { role: 1 },
    { role: ["admin"] },
  ])("rejects %j", (body) => {
    expect(() => validateRole(body)).toThrow(/Invalid input/);
  });
});
