import type { ReactNode } from "react";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import {
  FILTER_ERROR_ID,
  hasActiveFilters,
  issueId,
  parseAuditFilters,
  rawAuditQuery,
  type FilterIssue,
  type RawAuditQuery,
} from "@/lib/audit-filters";
import {
  actorLabel,
  auditEventsQuery,
  isRejectedFilters,
  listAuditEvents,
  shortId,
  type AuditEvent,
  type AuditFilters,
} from "@/lib/audits";
import { fetchMe } from "@/lib/me";
import { fetchOrg } from "@/lib/orgs";
import { AuditFilterForm } from "./audit-filter-form";

export const dynamic = "force-dynamic";

type Query = RawAuditQuery & { cursor?: string };

const REJECTED_MESSAGE =
  "The service rejected these filters. Apply the filters again or clear them.";

function auditColumns(youId?: string): Column<AuditEvent>[] {
  return [
    {
      key: "time",
      header: "Time",
      className: "max-sm:order-1",
      cell: (event) => (
        <LocalTime iso={event.createdAt} className="whitespace-nowrap tabular-nums" />
      ),
    },
    {
      key: "action",
      header: "Action",
      className: "max-sm:order-3 max-sm:col-span-2",
      cell: (event) => <code className="break-words">{event.action}</code>,
    },
    {
      key: "result",
      header: "Result",
      className: "max-sm:order-4",
      cell: (event) => (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge status={event.result === "success" ? "succeeded" : "failed"} />
          {event.failureCode && <code>{event.failureCode}</code>}
        </span>
      ),
    },
    {
      key: "actor",
      header: "Actor",
      className: "max-sm:order-2 max-sm:justify-self-end max-sm:text-muted-foreground",
      cell: (event) => (
        <code title={event.actorUserId}>{actorLabel(event.actorUserId, youId)}</code>
      ),
    },
    {
      key: "target",
      header: "Target",
      className: "max-sm:order-5 max-sm:justify-self-end",
      cell: (event) => (
        <span className="flex flex-wrap items-baseline gap-x-1.5 max-sm:justify-end">
          <span className="text-muted-foreground">{event.targetType}</span>
          {event.targetId && <code title={event.targetId}>{shortId(event.targetId)}</code>}
        </span>
      ),
    },
  ];
}

function FilterIssues({ issues }: { issues: FilterIssue[] }) {
  return (
    <ErrorState
      testId={FILTER_ERROR_ID}
      title="Check the filters"
      message="Fix the following and filter again."
    >
      <ul className="mt-1 list-disc pl-5">
        {issues.map((issue) => (
          <li key={issue.field} id={issueId(issue.field)}>
            {issue.message}
          </li>
        ))}
      </ul>
    </ErrorState>
  );
}

type EventsResult = Awaited<ReturnType<typeof listAuditEvents>>;

/** A rejected filter is user input (validation); anything else is an outage with a reference. */
function EventsFailure({ result }: { result: Extract<EventsResult, { ok: false }> }) {
  if (isRejectedFilters(result))
    return (
      <ErrorState testId={FILTER_ERROR_ID} title="Check the filters" message={REJECTED_MESSAGE} />
    );

  return (
    <ErrorState
      testId="api-unavailable"
      title="Audit history is temporarily unavailable"
      message="Try again shortly."
      correlationId={result.correlationId}
    />
  );
}

async function Events({
  orgId,
  filters,
  cursor,
}: {
  orgId: string;
  filters: AuditFilters;
  cursor?: string;
}) {
  const [events, me] = await Promise.all([listAuditEvents(orgId, filters, cursor), fetchMe()]);

  if (!events.ok) return <EventsFailure result={events} />;

  const { items, nextCursor } = events.data;

  return (
    <DataTable
      testId="audit-events"
      rows={items}
      rowKey={(event) => event.id}
      columns={auditColumns(me.ok ? me.data.id : undefined)}
      empty={<EmptyState testId="no-audit-events" title="No audit events match these filters." />}
      stackedRow="max-sm:grid-cols-[1fr_auto]"
      loadMoreLabel="More audit events"
      loadMoreHref={nextCursor ? `?${auditEventsQuery(filters, nextCursor)}` : null}
    />
  );
}

async function History({ orgId, query }: { orgId: string; query: Query }) {
  const { filters, issues } = parseAuditFilters(query);

  return (
    <>
      <AuditFilterForm filters={filters} issues={issues} canClear={hasActiveFilters(query)} />
      {issues.length > 0 ? (
        <FilterIssues issues={issues} />
      ) : (
        <Events orgId={orgId} filters={filters} cursor={query.cursor} />
      )}
    </>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader title="Audit history" />
      {children}
    </>
  );
}

export default async function AuditEventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Parameters<typeof rawAuditQuery>[0]>;
}) {
  const [{ slug }, search] = await Promise.all([params, searchParams]);
  const query = rawAuditQuery(search);
  const org = await fetchOrg(slug);

  if (!org.ok)
    return (
      <ErrorState
        testId="api-unavailable"
        title="The service is temporarily unavailable"
        message="Try again shortly."
        correlationId={org.correlationId}
      />
    );

  if (org.data.role !== "admin")
    return (
      <Page>
        <EmptyState
          title="You do not have access to audit history."
          description="Only organization admins can view it."
        />
      </Page>
    );

  return (
    <Page>
      <History orgId={org.data.id} query={query} />
    </Page>
  );
}
