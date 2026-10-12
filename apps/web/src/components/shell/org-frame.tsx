"use client";

import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import { LegacyPage } from "./legacy-page";

/**
 * Org routes get the header and page column here. Project routes render their own header (it needs
 * the project name, which only the project layout knows), so this steps aside for them.
 */
export function OrgFrame({ header, children }: { header: ReactNode; children: ReactNode }) {
  const { projectSlug } = useParams<{ projectSlug?: string }>();
  if (projectSlug) return children;
  return (
    <>
      {header}
      <LegacyPage>{children}</LegacyPage>
    </>
  );
}
