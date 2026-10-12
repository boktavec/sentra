import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { Named } from "@/lib/shell";
import { Breadcrumbs } from "./breadcrumbs";

/** Top bar of the shell: sidebar toggle, breadcrumbs, an optional switcher, and the theme toggle. */
export function ShellHeader({
  org,
  project,
  switcher,
}: {
  org: Named | null;
  project?: Named;
  switcher?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-4" />
      <Breadcrumbs org={org} project={project} switcher={switcher} />
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}
