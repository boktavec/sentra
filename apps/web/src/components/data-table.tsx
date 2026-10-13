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

// Below `sm`, a table with a `stackedRow` layout turns each row into a small grid so nothing needs a
// sideways scroll to reach (row actions especially). The header stays for screen readers only.
const STACKED_TABLE = "max-sm:block max-sm:[&_tbody]:block max-sm:[&_thead]:sr-only";

const STACKED_ROW =
  "max-sm:grid max-sm:h-auto max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1 max-sm:py-2";

const STACKED_CELL = "max-sm:min-w-0 max-sm:p-0 max-sm:whitespace-normal";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
}

function HeaderRow<T>({ columns }: { columns: Column<T>[] }) {
  return (
    <TableHeader>
      <TableRow>
        {columns.map((column) => (
          <TableHead key={column.key} className={column.className}>
            {column.header}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

function LoadMore({ href, label }: { href?: string | null; label: string }) {
  if (!href) return null;

  return (
    <p className="my-3">
      <Link href={href}>{label}</Link>
    </p>
  );
}

function DataRow<T>({
  row,
  columns,
  accent,
  attributes,
  stacked,
}: {
  row: T;
  columns: Column<T>[];
  accent?: RowAccent;
  attributes?: Record<`data-${string}`, string>;
  stacked?: string;
}) {
  return (
    <TableRow className={cn("h-9", stacked && STACKED_ROW, stacked)} {...attributes}>
      {columns.map((column, index) => (
        <TableCell
          key={column.key}
          className={cn(
            stacked && STACKED_CELL,
            column.className,
            index === 0 && accent && ACCENT_CLASSES[accent],
          )}
        >
          {column.cell(row)}
        </TableCell>
      ))}
    </TableRow>
  );
}

/** Server-rendered table; `empty` (an EmptyState) replaces it when there are no rows. Sorting and filtering are URL params (see FilterBar); paging is a link. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowAccent,
  rowProps,
  stackedRow,
  empty,
  loadMoreHref,
  loadMoreLabel = "Load more",
  testId,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowAccent?: (row: T) => RowAccent | undefined;
  /** Extra attributes for a row, such as test IDs and data-* values. */
  rowProps?: (row: T) => Record<`data-${string}`, string>;
  /** Grid template classes (`max-sm:grid-cols-...`) that stack each row below `sm`; give columns `max-sm:order-*` / `max-sm:col-span-*` to place them. */
  stackedRow?: string;
  empty?: ReactNode;
  loadMoreHref?: string | null;
  loadMoreLabel?: string;
  testId?: string;
}) {
  if (rows.length === 0 && empty) return empty;

  return (
    <>
      <Table data-testid={testId} className={stackedRow ? STACKED_TABLE : undefined}>
        <HeaderRow columns={columns} />
        <TableBody>
          {rows.map((row) => (
            <DataRow
              key={rowKey(row)}
              row={row}
              columns={columns}
              accent={rowAccent?.(row)}
              attributes={rowProps?.(row)}
              stacked={stackedRow}
            />
          ))}
        </TableBody>
      </Table>
      <LoadMore href={loadMoreHref} label={loadMoreLabel} />
    </>
  );
}
