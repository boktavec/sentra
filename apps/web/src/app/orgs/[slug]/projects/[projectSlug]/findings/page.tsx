import Link from "next/link";
import { Suspense } from "react";
import { fetchProjectScope } from "@/lib/projects";
import {
  listFindings,
  type Finding,
  type FindingFilters,
  type FindingPriorityFilter,
  type FindingSeverity,
  type FindingSort,
  type FindingStatus,
} from "@/lib/findings";
import { kevLabel, optionLabel, severityLabel } from "@/lib/finding-format";
import { RefreshButton } from "./refresh-button";

export const dynamic = "force-dynamic";

const STATUSES: FindingStatus[] = ["open", "resolved", "all"];
const SORTS: FindingSort[] = ["priority", "severity", "newest"];
const PRIORITIES: FindingPriorityFilter[] = ["all", "p1", "p2", "p3", "p4"];
const SEVERITIES: FindingSeverity[] = [
  "all",
  "critical",
  "high",
  "medium",
  "low",
  "none",
  "unavailable",
];

const badge = {
  border: "1px solid #6b7280",
  borderRadius: 4,
  padding: "0 0.4rem",
  fontWeight: 600,
} as const;

function FindingDetails({ finding }: { finding: Finding }) {
  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: "max-content minmax(0, 1fr)",
        gap: "0.5rem 1rem",
        marginBottom: 0,
      }}
    >
      <dt>Dependency</dt>
      <dd style={{ margin: 0, overflowWrap: "anywhere" }}>
        <code>{finding.purl}</code>
      </dd>
      <dt>Priority</dt>
      <dd style={{ margin: 0 }}>{finding.priority.tier}</dd>
      <dt>Severity</dt>
      <dd style={{ margin: 0 }}>{severityLabel(finding.vulnerability)}</dd>
      <dt>Exploitation</dt>
      <dd style={{ margin: 0 }}>{kevLabel(finding.kevStatus)}</dd>
      <dt>Match</dt>
      <dd style={{ margin: 0 }}>
        {finding.matchQuality === "confirmed" ? "Confirmed" : "Unverifiable"}
      </dd>
      <dt>Sources</dt>
      <dd style={{ margin: 0, overflowWrap: "anywhere" }}>
        {finding.sources.map((s) => `${s.source}: ${s.sourceId}`).join(", ")}
      </dd>
      {finding.vulnerability.cvssSource && (
        <>
          <dt>Score source</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>
            {finding.vulnerability.cvssSource.source}: {finding.vulnerability.cvssSource.sourceId}
          </dd>
        </>
      )}
    </dl>
  );
}

function FindingCard({ finding, base }: { finding: Finding; base: string }) {
  return (
    <li
      data-testid="finding-row"
      style={{
        border: "1px solid #d1d5db",
        borderRadius: 8,
        padding: "1rem",
        marginBottom: "1rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "1rem",
          alignItems: "baseline",
        }}
      >
        <strong style={{ overflowWrap: "anywhere" }}>
          <Link href={`${base}/findings/${finding.id}`}>
            {finding.vulnerability.aliases.find((a) => a.startsWith("CVE-")) ??
              finding.vulnerability.sourceId}
          </Link>
        </strong>
        <span>
          <span data-testid="priority-badge" style={badge}>
            {finding.priority.tier}
          </span>{" "}
          {optionLabel(finding.status)}
        </span>
      </div>
      {finding.vulnerability.summary && <p>{finding.vulnerability.summary}</p>}
      <FindingDetails finding={finding} />
    </li>
  );
}

function FindingsTable({ items, base }: { items: Finding[]; base: string }) {
  return (
    <ul data-testid="findings-list" style={{ listStyle: "none", padding: 0 }}>
      {items.map((finding) => (
        <FindingCard key={finding.id} finding={finding} base={base} />
      ))}
    </ul>
  );
}

function Select<T extends string>({
  label,
  name,
  value,
  options,
}: {
  label: string;
  name: keyof FindingFilters;
  value: T;
  options: T[];
}) {
  // The label names only the text, not the options, so each control is addressable by its own name.
  return (
    <>
      <label htmlFor={name}>{label}</label>{" "}
      <select id={name} name={name} defaultValue={value}>
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
    </>
  );
}

function FilterForm({ filters }: { filters: FindingFilters }) {
  return (
    <form method="get">
      <Select label="Sort" name="sort" value={filters.sort} options={SORTS} />{" "}
      <Select label="Priority" name="priority" value={filters.priority} options={PRIORITIES} />{" "}
      <Select label="Status" name="status" value={filters.status} options={STATUSES} />{" "}
      <Select label="Severity" name="severity" value={filters.severity} options={SEVERITIES} />{" "}
      <button type="submit">Apply filters</button> <RefreshButton />
    </form>
  );
}

async function FindingsResults({
  orgId,
  projectSlug,
  filters,
  cursor,
  base,
}: {
  orgId: string;
  projectSlug: string;
  filters: FindingFilters;
  cursor?: string;
  base: string;
}) {
  const result = await listFindings(orgId, projectSlug, filters, cursor);
  if (!result.ok)
    return (
      <p role="alert" data-testid="findings-error">
        Findings are temporarily unavailable. Reference: {result.correlationId}
      </p>
    );
  if (result.data.items.length === 0)
    return (
      <p data-testid="no-findings">
        No {filters.status === "open" ? "open " : ""}findings match these filters.
      </p>
    );
  return (
    <>
      <FindingsTable items={result.data.items} base={base} />
      <NextPageLink cursor={result.data.nextCursor} filters={filters} base={base} />
    </>
  );
}

function NextPageLink({
  cursor,
  filters,
  base,
}: {
  cursor: string | null;
  filters: FindingFilters;
  base: string;
}) {
  if (!cursor) return null;
  const next = new URLSearchParams({ ...filters, cursor });
  return (
    <p>
      <Link href={`${base}/findings?${next}`}>Next page</Link>
    </p>
  );
}

const choose = <T extends string>(options: T[], value: string | undefined, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

export default async function FindingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
  searchParams: Promise<Partial<Record<keyof FindingFilters | "cursor", string>>>;
}) {
  const { slug, projectSlug } = await params;
  const query = await searchParams;
  const filters: FindingFilters = {
    status: choose(STATUSES, query.status, "open"),
    severity: choose(SEVERITIES, query.severity, "all"),
    sort: choose(SORTS, query.sort, "priority"),
    priority: choose(PRIORITIES, query.priority, "all"),
  };
  const scope = await fetchProjectScope(slug, projectSlug);
  if (!scope.ok)
    return (
      <main role="alert">
        The service is temporarily unavailable. Reference: {scope.correlationId}
      </main>
    );
  const base = `/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(projectSlug)}`;

  return (
    <main>
      <p>
        <Link href={base}>{scope.project.name}</Link>
      </p>
      <h1>Findings</h1>
      <p>Current project vulnerability findings, grouped by dependency and issue.</p>
      <FilterForm filters={filters} />
      <Suspense
        key={`${Object.values(filters).join(":")}:${query.cursor ?? ""}`}
        fallback={<p role="status">Loading findings…</p>}
      >
        <FindingsResults
          orgId={scope.org.id}
          projectSlug={projectSlug}
          filters={filters}
          cursor={query.cursor}
          base={base}
        />
      </Suspense>
    </main>
  );
}
