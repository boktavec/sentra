import type { ReactNode } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { SignOutButton } from "./sign-out-button";

/**
 * Frame for pages outside an organization: wordmark, theme toggle, Sign out, one centered column.
 * Signed-out visitors never reach these routes (the proxy sends them to sign-in), so Sign out is
 * always valid.
 */
export function CenteredLayout({
  children,
  width = "narrow",
}: {
  children: ReactNode;
  width?: "narrow" | "wide";
}) {
  return (
    <div className="min-h-svh">
      <header className="flex h-12 items-center justify-between border-b px-4">
        <Link href="/" className="font-semibold tracking-tight">
          Sentra
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <SignOutButton />
        </div>
      </header>
      <main
        className={cn(
          "mx-auto w-full px-4 py-8 md:px-6 md:py-12",
          width === "wide" ? "max-w-2xl" : "max-w-md",
        )}
      >
        {children}
      </main>
    </div>
  );
}
