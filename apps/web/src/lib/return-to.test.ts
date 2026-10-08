import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./return-to.ts";

describe("safeReturnPath", () => {
  it.each(["/", "/orgs/acme", "/invitations/accept?token=abc_-123", "/a/b?x=1&y=2#z"])(
    "keeps the same-site path %s",
    (path) => {
      expect(safeReturnPath(path)).toBe(path);
    },
  );

  it.each([
    undefined,
    "",
    "orgs/acme",
    "//evil.test",
    "/\\evil.test",
    "https://evil.test/",
    "http://localhost:3000/",
    "javascript:alert(1)",
    "/ok\nSet-Cookie: x=1",
    "/ok\u0000",
    `/${"a".repeat(2048)}`,
  ])("falls back to the home page for %j", (path) => {
    expect(safeReturnPath(path)).toBe("/");
  });
});
