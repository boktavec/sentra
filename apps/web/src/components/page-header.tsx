import type { ReactNode } from "react";

export function PageHeader({
  title,
  titleTestId,
  description,
  actions,
}: {
  title: string;
  titleTestId?: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1
          data-testid={titleTestId}
          className="text-xl font-semibold tracking-tight wrap-anywhere"
        >
          {title}
        </h1>
        {description && <p className="mt-1 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
