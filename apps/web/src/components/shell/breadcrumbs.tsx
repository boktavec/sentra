"use client";

import { Fragment, type ReactNode } from "react";
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
  const crumbs = buildBreadcrumbs(usePathname(), org, project);
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((crumb, index) => (
          <Fragment key={`${index}-${crumb.label}`}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem className="min-w-0">
              <CrumbLabel crumb={crumb} />
              {index === PROJECT_CRUMB_INDEX && switcher}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
