import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** GET form layout: filters live in the URL, so it works without JavaScript. */
export function FilterBar({
  action,
  children,
  submitLabel,
}: {
  action?: string;
  children: ReactNode;
  submitLabel: string;
}) {
  return (
    <form method="get" action={action} className="my-3 flex flex-wrap items-end gap-3">
      {children}
      <Button type="submit" variant="secondary" size="sm">
        {submitLabel}
      </Button>
    </form>
  );
}
