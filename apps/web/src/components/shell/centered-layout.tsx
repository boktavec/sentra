import type { ReactNode } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { LegacyPage } from "./legacy-page";

/** Frame for pages outside an organization: wordmark, theme toggle, one centered column. */
export function CenteredLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh">
      <header className="flex h-12 items-center justify-between border-b px-4">
        <Link href="/" className="font-semibold tracking-tight">
          Sentra
        </Link>
        <ThemeToggle />
      </header>
      <LegacyPage className="max-w-2xl">{children}</LegacyPage>
    </div>
  );
}
