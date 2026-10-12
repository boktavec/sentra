import { describe, expect, it } from "vitest";
import { orgPathPreview, slugify } from "./slugify";

describe("slugify", () => {
  it("lowercases, hyphenates and trims", () => {
    expect(slugify("  Acme Security, Inc.  ")).toBe("acme-security-inc");
  });

  it("caps the slug at 40 characters without a trailing hyphen", () => {
    const slug = slugify(`${"a".repeat(39)} b`);
    expect(slug).toBe("a".repeat(39));
  });
});

describe("orgPathPreview", () => {
  it("shows a placeholder while the slug is empty", () => {
    expect(orgPathPreview("")).toBe("/orgs/<slug>");
    expect(orgPathPreview("   ")).toBe("/orgs/<slug>");
  });

  it("shows the typed slug", () => {
    expect(orgPathPreview("acme")).toBe("/orgs/acme");
  });
});
