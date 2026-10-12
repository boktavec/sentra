import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { FilterBar } from "@/components/filter-bar";
import { DetailSkeleton, PageHeaderSkeleton, TableSkeleton } from "@/components/loading-state";
import { PageHeader } from "@/components/page-header";
import { SeverityBadge } from "@/components/severity-badge";
import { StatusBadge } from "@/components/status-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  SEVERITY_LEVELS,
  STATUS_LABELS,
  type SeverityLevel,
  type StatusName,
} from "@/lib/badge-status";

export const dynamic = "force-dynamic";

// Static fixtures only: no API calls and no tenant data.
interface FixtureRow {
  id: string;
  cve: string;
  severity: SeverityLevel;
  status: StatusName;
  purl: string;
}

const ROWS: FixtureRow[] = [
  {
    id: "1",
    cve: "CVE-2024-0001",
    severity: "critical",
    status: "open",
    purl: "pkg:npm/left-pad@1.0.0",
  },
  {
    id: "2",
    cve: "CVE-2024-0002",
    severity: "high",
    status: "kev",
    purl: "pkg:pypi/requests@2.0.0",
  },
  {
    id: "3",
    cve: "CVE-2024-0003",
    severity: "medium",
    status: "resolved",
    purl: "pkg:maven/org.example/very-long-artifact-name-that-should-wrap@1.2.3",
  },
  {
    id: "4",
    cve: "CVE-2024-0004",
    severity: "low",
    status: "open",
    purl: "pkg:golang/example.com/mod@v1.0.0",
  },
  {
    id: "5",
    cve: "CVE-2024-0005",
    severity: "info",
    status: "open",
    purl: "pkg:cargo/serde@1.0.0",
  },
];

const COLUMNS: Column<FixtureRow>[] = [
  { key: "cve", header: "Vulnerability", cell: (row) => <code>{row.cve}</code> },
  { key: "severity", header: "Severity", cell: (row) => <SeverityBadge level={row.severity} /> },
  { key: "status", header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
  {
    key: "purl",
    header: "Dependency",
    className: "whitespace-normal",
    cell: (row) => <code className="wrap-anywhere">{row.purl}</code>,
  },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 border-b pb-1 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default function DevUiPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader
        title="UI reference"
        description="Every shared primitive in every variant. Development only."
        actions={
          <>
            <ThemeToggle />
            <Button size="sm">Primary action</Button>
          </>
        }
      />

      <Section title="Severity badges">
        <div className="flex flex-wrap gap-2">
          {SEVERITY_LEVELS.map((level) => (
            <SeverityBadge key={level} level={level} />
          ))}
        </div>
      </Section>

      <Section title="Status badges">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(STATUS_LABELS) as StatusName[]).map((status) => (
            <StatusBadge key={status} status={status} />
          ))}
        </div>
      </Section>

      <Section title="Filter bar">
        <FilterBar action="/dev/ui" submitLabel="Apply">
          <label className="flex flex-col gap-1 text-xs">
            Severity
            <select name="severity" defaultValue="">
              <option value="">All</option>
              {SEVERITY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
        </FilterBar>
      </Section>

      <Section title="Data table with critical and high row accents and Load more">
        <DataTable
          testId="dev-table"
          columns={COLUMNS}
          rows={ROWS}
          rowKey={(row) => row.id}
          rowAccent={(row) =>
            row.severity === "critical" || row.severity === "high" ? row.severity : undefined
          }
          loadMoreHref="/dev/ui?cursor=next"
        />
      </Section>

      <Section title="Data table, empty slot">
        <DataTable
          columns={COLUMNS}
          rows={[]}
          rowKey={(row) => row.id}
          empty={
            <EmptyState title="No findings" description="Upload an SBOM to see findings here." />
          }
        />
      </Section>

      <Section title="Empty state with action">
        <EmptyState
          title="No projects yet"
          description="Create a project to start tracking dependencies."
          action={<Button size="sm">Create project</Button>}
        />
      </Section>

      <Section title="Error state with reference">
        <ErrorState
          title="The service is unavailable"
          message="Try again in a moment."
          correlationId="3f9c2a7e-0000-4000-8000-fixture00001"
        />
      </Section>

      <Section title="Loading states">
        <div className="space-y-6">
          <PageHeaderSkeleton />
          <TableSkeleton rows={3} />
          <DetailSkeleton />
        </div>
      </Section>

      <Section title="Long names truncate">
        <p
          className="max-w-48 truncate"
          title="An extremely long organization name that cannot fit"
        >
          An extremely long organization name that cannot fit
        </p>
      </Section>
    </div>
  );
}
