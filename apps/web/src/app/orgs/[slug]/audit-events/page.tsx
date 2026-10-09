import Link from "next/link";
import { auditEventsQuery, listAuditEvents, type AuditFilters } from "@/lib/audits";
import { fetchOrg } from "@/lib/orgs";

export const dynamic = "force-dynamic";
type Query = Partial<Record<keyof AuditFilters | "cursor", string>>;

function Filters({ filters }: { filters: AuditFilters }) {
  return (
    <form method="get">
      <label>
        From (UTC ISO 8601) <input name="from" defaultValue={filters.from} />
      </label>{" "}
      <label>
        To (UTC ISO 8601) <input name="to" defaultValue={filters.to} />
      </label>{" "}
      <label>
        Actor ID <input name="actorId" defaultValue={filters.actorId} />
      </label>{" "}
      <label>
        Action <input name="action" defaultValue={filters.action} />
      </label>{" "}
      <label>
        Result{" "}
        <select name="result" defaultValue={filters.result ?? ""}>
          <option value="">All</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
        </select>
      </label>{" "}
      <button type="submit">Filter</button>
    </form>
  );
}

function filtersOf(query: Query): AuditFilters {
  const result = ["success", "failed"].includes(query.result ?? "")
    ? (query.result as "success" | "failed")
    : undefined;
  return { from: query.from, to: query.to, actorId: query.actorId, action: query.action, result };
}

function nextHref(filters: AuditFilters, cursor: string) {
  return `?${auditEventsQuery(filters, cursor)}`;
}

function Events({ page }: { page: Awaited<ReturnType<typeof listAuditEvents>> }) {
  if (!page.ok)
    return (
      <p data-testid="api-unavailable">
        Audit history is temporarily unavailable. Reference: {page.correlationId}
      </p>
    );
  if (page.data.items.length === 0)
    return <p data-testid="no-audit-events">No audit events match these filters.</p>;
  return (
    <table data-testid="audit-events">
      <thead>
        <tr>
          <th>Time</th>
          <th>Action</th>
          <th>Result</th>
          <th>Actor</th>
          <th>Target</th>
        </tr>
      </thead>
      <tbody>
        {page.data.items.map((event) => (
          <tr key={event.id}>
            <td>{new Date(event.createdAt).toLocaleString("en-US")}</td>
            <td>{event.action}</td>
            <td>
              {event.result}
              {event.failureCode ? ` (${event.failureCode})` : ""}
            </td>
            <td>
              <code>{event.actorUserId}</code>
            </td>
            <td>
              {event.targetType}
              {event.targetId ? `: ${event.targetId}` : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NextPage({
  page,
  filters,
}: {
  page: Awaited<ReturnType<typeof listAuditEvents>>;
  filters: AuditFilters;
}) {
  if (!page.ok || !page.data.nextCursor) return null;
  return (
    <p>
      <Link href={nextHref(filters, page.data.nextCursor)}>More audit events</Link>
    </p>
  );
}

async function History({ slug, orgId, query }: { slug: string; orgId: string; query: Query }) {
  const filters = filtersOf(query);
  const events = await listAuditEvents(orgId, filters, query.cursor);
  return (
    <main>
      <p>
        <Link href={`/orgs/${slug}`}>Organization</Link>
      </p>
      <h1>Audit history</h1>
      <Filters filters={filters} />
      <Events page={events} />
      <NextPage page={events} filters={filters} />
    </main>
  );
}

export default async function AuditEventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Query>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const org = await fetchOrg(slug);
  if (!org.ok)
    return (
      <main>
        <p data-testid="api-unavailable">
          The service is temporarily unavailable. Reference: {org.correlationId}
        </p>
      </main>
    );
  if (org.data.role !== "admin")
    return (
      <main>
        <p>You do not have access to audit history.</p>
      </main>
    );
  return <History slug={slug} orgId={org.data.id} query={query} />;
}
