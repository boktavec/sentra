import type { ReactNode } from "react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type RowAccent = "critical" | "high";

// Left edge marker on a row's first cell; box-shadow so it doesn't shift the table layout.
const ACCENT_CLASSES: Record<RowAccent, string> = {
  critical: "shadow-[inset_3px_0_0_0_var(--severity-critical)]",
  high: "shadow-[inset_3px_0_0_0_var(--severity-high)]",
};

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
}

/** Server-rendered table; `empty` (an EmptyState) replaces it when there are no rows. Sorting and filtering are URL params (see FilterBar); paging is a link. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowAccent,
  empty,
  loadMoreHref,
  loadMoreLabel = "Load more",
  testId,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowAccent?: (row: T) => RowAccent | undefined;
  empty?: ReactNode;
  loadMoreHref?: string | null;
  loadMoreLabel?: string;
  testId?: string;
}) {
  if (rows.length === 0 && empty) return empty;

  return (
    <>
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column.key} className={column.className}>
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const accent = rowAccent?.(row);

            return (
              <TableRow key={rowKey(row)} className="h-9">
                {columns.map((column, index) => (
                  <TableCell
                    key={column.key}
                    className={cn(
                      column.className,
                      index === 0 && accent && ACCENT_CLASSES[accent],
                    )}
                  >
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {loadMoreHref && (
        <p className="my-3">
          <Link href={loadMoreHref}>{loadMoreLabel}</Link>
        </p>
      )}
    </>
  );
}
