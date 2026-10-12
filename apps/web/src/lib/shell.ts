/** Pure helpers for the app shell: switcher lists, navigation and breadcrumbs. */

export const SWITCHER_LIMIT = 20;

export interface Named {
  name: string;
  slug: string;
}

/**
 * Items for a switcher. `list` is null when the list call failed: show only what the lookup
 * returned (the current item). Otherwise show at most SWITCHER_LIMIT items and always include the
 * current one, so it can be marked even when it falls outside the first page.
 */
export function switcherItems<T extends Named>(list: T[] | null, current: T): T[] {
  if (list === null) return [current];
  const capped = list.slice(0, SWITCHER_LIMIT);
  if (capped.some((item) => item.slug === current.slug)) return capped;
  return [...capped.slice(0, SWITCHER_LIMIT - 1), current];
}

export interface NavItem {
  label: string;
  href: string;
  /** Exact match only; otherwise the item is active for any path below `href`. */
  exact?: boolean;
}

export function orgNav(orgSlug: string, role: "admin" | "member"): NavItem[] {
  const base = `/orgs/${encodeURIComponent(orgSlug)}`;
  return [
    { label: "Projects", href: base, exact: true },
    { label: "Members", href: `${base}/members` },
    ...(role === "admin" ? [{ label: "Audit events", href: `${base}/audit-events` }] : []),
  ];
}

export function projectNav(orgSlug: string, projectSlug: string): NavItem[] {
  const base = `/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectSlug)}`;
  return [
    { label: "Overview", href: base, exact: true },
    { label: "Findings", href: `${base}/findings` },
    { label: "Investigations", href: `${base}/investigations` },
  ];
}

export function isActive(pathname: string, item: NavItem): boolean {
  return pathname === item.href || (!item.exact && pathname.startsWith(`${item.href}/`));
}

export interface Crumb {
  label: string;
  /** Absent on the current page. */
  href?: string;
}

// Org-level sections under /orgs/<slug>/.
const ORG_SECTIONS: Record<string, string> = { members: "Members", "audit-events": "Audit events" };
// Project-level sections under /orgs/<slug>/projects/<project>/.
const PROJECT_SECTIONS: Record<string, string> = {
  findings: "Findings",
  investigations: "Investigations",
};

/**
 * Breadcrumb trail for a path. Names come only from the org and project the API returned; the
 * rest are fixed section labels, so no other URL text is shown. Without an org (lookup failed)
 * the trail is just "Organizations".
 */
export function buildBreadcrumbs(pathname: string, org: Named | null, project?: Named): Crumb[] {
  const root: Crumb = { label: "Organizations", href: "/" };
  if (!org) return [{ label: root.label }];
  const orgHref = `/orgs/${encodeURIComponent(org.slug)}`;
  const rest = pathname.split("/").filter(Boolean).slice(2);
  const crumbs: Crumb[] = [root, { label: org.name, href: orgHref }];
  const last = (label: string) => crumbs.push({ label });

  if (project) {
    const projectHref = `${orgHref}/projects/${encodeURIComponent(project.slug)}`;
    crumbs.push({ label: project.name, href: projectHref });
    const section = PROJECT_SECTIONS[rest[2] ?? ""];
    if (section) {
      crumbs.push({ label: section, href: `${projectHref}/${rest[2]}` });
      if (rest[2] === "findings" && rest[3]) last("Finding");
    }
  } else {
    const section = ORG_SECTIONS[rest[0] ?? ""];
    if (section) crumbs.push({ label: section, href: `${orgHref}/${rest[0]}` });
  }
  const tail = crumbs[crumbs.length - 1]!;
  if (tail.href) crumbs[crumbs.length - 1] = { label: tail.label };
  return crumbs;
}
