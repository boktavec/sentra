import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Layout of a filter form; the audit filter form is a client component and reuses it. */
export const FILTER_BAR_CLASS = "my-3 flex flex-wrap items-end gap-3";

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
    <form method="get" action={action} className={FILTER_BAR_CLASS}>
      {children}
      <Button type="submit" variant="secondary" size="sm">
        {submitLabel}
      </Button>
    </form>
  );
}
