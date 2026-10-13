"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";
import { buildBreadcrumbs, type Crumb, type Named } from "@/lib/shell";

// Organizations / <org> / <project>
const PROJECT_CRUMB_INDEX = 2;

function CrumbLabel({ crumb }: { crumb: Crumb }) {
  if (!crumb.href) {
    return (
      <BreadcrumbPage title={crumb.label} className="truncate">
        {crumb.label}
      </BreadcrumbPage>
    );
  }

  return (
    <BreadcrumbLink asChild>
      <Link href={crumb.href} title={crumb.label} className="truncate">
        {crumb.label}
      </Link>
    </BreadcrumbLink>
  );
}

function CrumbItem({
  crumb,
  separatorClass,
  trailing,
}: {
  crumb: Crumb;
  separatorClass?: string;
  trailing?: ReactNode;
}) {
  return (
    <>
      <BreadcrumbSeparator className={separatorClass} />
      <BreadcrumbItem className="min-w-0">
        <CrumbLabel crumb={crumb} />
        {trailing}
      </BreadcrumbItem>
    </>
  );
}

/** Trail for the current path; names are the org/project the API returned, truncated with the full name in `title`. */
export function Breadcrumbs({
  org,
  project,
  switcher,
}: {
  org: Named | null;
  project?: Named;
  /** Rendered right after the project crumb. */
  switcher?: ReactNode;
}) {
  const [root, ...rest] = buildBreadcrumbs(usePathname(), org, project);
  // On narrow screens the root crumb is dropped from deep trails so the org and project stay legible.
  const hideRoot = rest.length > 1 ? "max-sm:hidden" : undefined;

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {root && (
          <BreadcrumbItem className={cn("min-w-0", hideRoot)}>
            <CrumbLabel crumb={root} />
          </BreadcrumbItem>
        )}
        {rest.map((crumb, i) => (
          <CrumbItem
            key={`${i}-${crumb.label}`}
            crumb={crumb}
            separatorClass={i === 0 ? hideRoot : undefined}
            trailing={i + 1 === PROJECT_CRUMB_INDEX ? switcher : undefined}
          />
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
