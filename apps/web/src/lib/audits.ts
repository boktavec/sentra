import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";

export type AuditResult = "success" | "failed";
interface AuditEvent {
  id: string;
  orgId: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: string;
  result: AuditResult;
  failureCode: string | null;
  correlationId: string | null;
}
type AuditPage = { items: AuditEvent[]; nextCursor: string | null };
export type AuditFilters = Partial<{
  from: string;
  to: string;
  actorId: string;
  action: string;
  result: AuditResult;
}>;

export function auditEventsQuery(filters: AuditFilters, cursor?: string) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export function listAuditEvents(orgId: string, filters: AuditFilters, cursor?: string) {
  const query = auditEventsQuery(filters, cursor);
  return callApi((token) =>
    apiGet<AuditPage>(`/v1/orgs/${orgId}/audit-events${query ? `?${query}` : ""}`, token),
  );
}
