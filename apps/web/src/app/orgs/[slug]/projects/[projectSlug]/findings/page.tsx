import Link from "next/link";
import { Suspense } from "react";
import { fetchProjectScope } from "@/lib/projects";
import {
  listFindings,
  type Finding,
  type FindingSeverity,
  type FindingStatus,
} from "@/lib/findings";
import { kevLabel, optionLabel, severityLabel } from "@/lib/finding-format";
import { RefreshButton } from "./refresh-button";

export const dynamic = "force-dynamic";

const STATUSES: FindingStatus[] = ["open", "resolved", "all"];
const SEVERITIES: FindingSeverity[] = [
  "all",
  "critical",
  "high",
  "medium",
  "low",
  "none",
  "unavailable",
];

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
        <span>{optionLabel(finding.status)}</span>
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

function FilterForm({ status, severity }: { status: FindingStatus; severity: FindingSeverity }) {
  return (
    <form method="get">
      <label>
        Status{" "}
        <select name="status" defaultValue={status}>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {optionLabel(value)}
            </option>
          ))}
        </select>
      </label>{" "}
      <label>
        Severity{" "}
        <select name="severity" defaultValue={severity}>
          {SEVERITIES.map((value) => (
            <option key={value} value={value}>
              {optionLabel(value)}
            </option>
          ))}
        </select>
      </label>{" "}
      <button type="submit">Apply filters</button> <RefreshButton />
    </form>
  );
}

async function FindingsResults({
  orgId,
  projectSlug,
  status,
  severity,
  cursor,
  base,
}: {
  orgId: string;
  projectSlug: string;
  status: FindingStatus;
  severity: FindingSeverity;
  cursor?: string;
  base: string;
}) {
  const result = await listFindings(orgId, projectSlug, status, severity, cursor);
  return <FindingsResponse result={result} status={status} severity={severity} base={base} />;
}

function FindingsResponse({
  result,
  status,
  severity,
  base,
}: {
  result: Awaited<ReturnType<typeof listFindings>>;
  status: FindingStatus;
  severity: FindingSeverity;
  base: string;
}) {
  if (!result.ok)
    return (
      <p role="alert" data-testid="findings-error">
        Findings are temporarily unavailable. Reference: {result.correlationId}
      </p>
    );
  if (result.data.items.length === 0)
    return (
      <p data-testid="no-findings">
        No {status === "open" ? "open " : ""}findings match these filters.
      </p>
    );
  return (
    <>
      <FindingsTable items={result.data.items} base={base} />
      <NextPageLink
        cursor={result.data.nextCursor}
        status={status}
        severity={severity}
        base={base}
      />
    </>
  );
}

function NextPageLink({
  cursor,
  status,
  severity,
  base,
}: {
  cursor: string | null;
  status: FindingStatus;
  severity: FindingSeverity;
  base: string;
}) {
  if (!cursor) return null;
  const next = new URLSearchParams({ status, severity, cursor });
  return (
    <p>
      <Link href={`${base}/findings?${next}`}>Next page</Link>
    </p>
  );
}

function selectedStatus(value: string | undefined): FindingStatus {
  return STATUSES.includes(value as FindingStatus) ? (value as FindingStatus) : "open";
}

function selectedSeverity(value: string | undefined): FindingSeverity {
  return SEVERITIES.includes(value as FindingSeverity) ? (value as FindingSeverity) : "all";
}

export default async function FindingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
  searchParams: Promise<{ status?: string; severity?: string; cursor?: string }>;
}) {
  const { slug, projectSlug } = await params;
  const query = await searchParams;
  const status = selectedStatus(query.status);
  const severity = selectedSeverity(query.severity);
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
      <FilterForm status={status} severity={severity} />
      <Suspense
        key={`${status}:${severity}:${query.cursor ?? ""}`}
        fallback={<p role="status">Loading findings…</p>}
      >
        <FindingsResults
          orgId={scope.org.id}
          projectSlug={projectSlug}
          status={status}
          severity={severity}
          cursor={query.cursor}
          base={base}
        />
      </Suspense>
    </main>
  );
}
