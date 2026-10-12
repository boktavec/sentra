import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Wraps page bodies that predate the design system (rebuilt in SENTRA-35..38). The data-legacy
 * attribute turns on the restored element styles in globals.css; nothing else is affected.
 */
export function LegacyPage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-legacy className={cn("mx-auto w-full max-w-4xl px-4 py-6 md:px-6", className)}>
      {children}
    </div>
  );
}
