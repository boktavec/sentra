import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
  testId,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center"
    >
      <p className="m-0 font-medium">{title}</p>
      {description && <p className="m-0 text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}
