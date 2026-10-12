"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { isActive, orgNav, projectNav, type NavItem } from "@/lib/shell";
import { EntitySwitcher, type SwitcherProps } from "./entity-switcher";

function NavList({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <SidebarMenu>
      {items.map((item) => {
        const active = isActive(pathname, item);
        return (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton asChild isActive={active}>
              <Link href={item.href} aria-current={active ? "page" : undefined}>
                {item.label}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

/**
 * Sidebar for org routes. Shows the org navigation, or the project navigation (with a link back to
 * the org) on project routes. `org` is null when the org lookup failed: only the wordmark and the
 * "All organizations" link remain.
 */
export function AppSidebar({
  org,
  switcher,
}: {
  org: { name: string; slug: string; role: "admin" | "member" } | null;
  switcher: SwitcherProps;
}) {
  const pathname = usePathname();
  const { projectSlug } = useParams<{ projectSlug?: string }>();
  const { setOpenMobile } = useSidebar();
  // The provider lives in the persistent layout, so the sheet would stay open across navigation.
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);
  return (
    <Sidebar>
      <SidebarHeader className="gap-1 p-3">
        <Link href="/" className="font-semibold tracking-tight">
          Sentra
        </Link>
        <div className="flex min-w-0 items-center gap-1">
          {org && (
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={org.name}>
              {org.name}
            </span>
          )}
          <EntitySwitcher {...switcher} />
        </div>
      </SidebarHeader>
      {org && (
        <SidebarContent>
          <nav aria-label="Primary">
            <SidebarGroup>
              {projectSlug ? (
                <>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild>
                        <Link href={`/orgs/${encodeURIComponent(org.slug)}`} title={org.name}>
                          <ChevronLeft aria-hidden />
                          <span className="truncate">{org.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                  <SidebarGroupLabel>Project</SidebarGroupLabel>
                  <NavList items={projectNav(org.slug, projectSlug)} pathname={pathname} />
                </>
              ) : (
                <>
                  <SidebarGroupLabel>Organization</SidebarGroupLabel>
                  <NavList items={orgNav(org.slug, org.role)} pathname={pathname} />
                </>
              )}
            </SidebarGroup>
          </nav>
        </SidebarContent>
      )}
    </Sidebar>
  );
}
