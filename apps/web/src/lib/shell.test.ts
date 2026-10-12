import { describe, expect, it } from "vitest";
import {
  buildBreadcrumbs,
  isActive,
  orgNav,
  projectNav,
  SWITCHER_LIMIT,
  switcherItems,
} from "./shell.ts";

const item = (n: number) => ({ name: `Item ${n}`, slug: `item-${n}` });
const many = Array.from({ length: 25 }, (_, i) => item(i));

describe("switcherItems", () => {
  it("shows only the current item when the list call failed", () => {
    expect(switcherItems(null, item(3))).toEqual([item(3)]);
  });

  it("caps the list at the limit", () => {
    expect(switcherItems(many, item(0))).toHaveLength(SWITCHER_LIMIT);
  });

  it("keeps the current item when it is outside the first page, without exceeding the limit", () => {
    const result = switcherItems(many, item(24));
    expect(result).toHaveLength(SWITCHER_LIMIT);
    expect(result.at(-1)).toEqual(item(24));
  });

  it("keeps the current item when it is missing from a short list", () => {
    expect(switcherItems([item(1)], item(2))).toEqual([item(1), item(2)]);
  });
});

describe("navigation", () => {
  it("shows audit events to admins only", () => {
    expect(orgNav("acme", "admin").map((i) => i.label)).toEqual([
      "Projects",
      "Members",
      "Audit events",
    ]);
    expect(orgNav("acme", "member").map((i) => i.label)).toEqual(["Projects", "Members"]);
  });

  it("marks exact items only on their own path and others on sub-paths", () => {
    const [overview, findings] = projectNav("acme", "web");
    expect(isActive("/orgs/acme/projects/web", overview!)).toBe(true);
    expect(isActive("/orgs/acme/projects/web/findings", overview!)).toBe(false);
    expect(isActive("/orgs/acme/projects/web/findings/abc", findings!)).toBe(true);
    expect(isActive("/orgs/acme/projects/web/findingsx", findings!)).toBe(false);
  });
});

describe("buildBreadcrumbs", () => {
  const org = { name: "Acme Corp", slug: "acme" };
  const project = { name: "Web App", slug: "web" };

  it("shows only the root when the org lookup failed", () => {
    expect(buildBreadcrumbs("/orgs/acme", null)).toEqual([{ label: "Organizations" }]);
  });

  it("ends the org page at the org name", () => {
    expect(buildBreadcrumbs("/orgs/acme", org)).toEqual([
      { label: "Organizations", href: "/" },
      { label: "Acme Corp" },
    ]);
  });

  it("adds org sections", () => {
    expect(buildBreadcrumbs("/orgs/acme/members", org).map((c) => c.label)).toEqual([
      "Organizations",
      "Acme Corp",
      "Members",
    ]);
  });

  it("links every crumb but the last on a finding page, without echoing the URL", () => {
    const crumbs = buildBreadcrumbs("/orgs/acme/projects/web/findings/<script>", org, project);
    expect(crumbs).toEqual([
      { label: "Organizations", href: "/" },
      { label: "Acme Corp", href: "/orgs/acme" },
      { label: "Web App", href: "/orgs/acme/projects/web" },
      { label: "Findings", href: "/orgs/acme/projects/web/findings" },
      { label: "Finding" },
    ]);
  });

  it("ends the project overview at the project name", () => {
    expect(buildBreadcrumbs("/orgs/acme/projects/web", org, project).at(-1)).toEqual({
      label: "Web App",
    });
  });
});
