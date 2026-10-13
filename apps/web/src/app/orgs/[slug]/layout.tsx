import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/shell/app-sidebar";
import type { SwitcherProps } from "@/components/shell/entity-switcher";
import { OrgFrame } from "@/components/shell/org-frame";
import { ShellHeader } from "@/components/shell/shell-header";
import { fetchOrg, listOrgs, type Org } from "@/lib/orgs";
import { switcherItems } from "@/lib/shell";

const SIDEBAR_COOKIE = "sidebar_state";

const ORG_SWITCHER = {
  noun: "organization",
  heading: "Organizations",
  allHref: "/",
  allLabel: "All organizations",
};

/** First page of the user's orgs; if that call fails, only the current org (the lookup answered). */
async function orgSwitcher(org: Org): Promise<SwitcherProps> {
  const orgs = await listOrgs();

  return {
    ...ORG_SWITCHER,
    currentSlug: org.slug,
    items: switcherItems(orgs.ok ? orgs.data.items : null, org).map((item) => ({
      name: item.name,
      slug: item.slug,
      href: `/orgs/${encodeURIComponent(item.slug)}`,
    })),
  };
}

/**
 * App shell for every /orgs/[slug] route. Shows only what the API returned: a failed lookup leaves
 * a minimal shell and the page renders its own error; a missing or foreign org is a 404 (thrown by
 * fetchOrg) with no shell at all.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const sidebarOpen = (await cookies()).get(SIDEBAR_COOKIE)?.value !== "false";
  const lookup = await fetchOrg(slug);
  const org = lookup.ok ? lookup.data : null;
  const switcher = org ? await orgSwitcher(org) : { ...ORG_SWITCHER, items: [] };

  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <AppSidebar org={org} switcher={switcher} />
      <SidebarInset>
        <OrgFrame header={<ShellHeader org={org} />}>{children}</OrgFrame>
      </SidebarInset>
    </SidebarProvider>
  );
}
