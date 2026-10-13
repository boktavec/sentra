import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";

export function ErrorState({
  title,
  message,
  correlationId,
  testId,
  children,
}: {
  title: string;
  message: string;
  correlationId?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex gap-3 rounded-lg border border-severity-critical-border bg-severity-critical-subtle p-4"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-muted-foreground">{message}</p>
        {children}
        {correlationId && (
          <p className="mt-1 text-xs text-muted-foreground">
            Reference: <code>{correlationId}</code>
          </p>
        )}
      </div>
    </div>
  );
}
