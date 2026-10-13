"use client";

import type { ReactNode } from "react";
import { useParams } from "next/navigation";

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
      <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">{children}</div>
    </>
  );
}
