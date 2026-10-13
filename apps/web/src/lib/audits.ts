import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";

export type AuditResult = "success" | "failed";

export interface AuditEvent {
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

const SHORT_ID_LENGTH = 8;

export const shortId = (id: string) => id.slice(0, SHORT_ID_LENGTH);

/** "You" for the signed-in user, else the short ID; `youId` is undefined when `/v1/me` failed. */
export const actorLabel = (actorUserId: string, youId?: string) =>
  actorUserId === youId ? "You" : shortId(actorUserId);

/** The API rejected the filters (a bad cursor, for example): user input, not an outage. */
export const isRejectedFilters = (result: { ok: boolean; status: number; code?: string }) =>
  !result.ok && result.status === 400 && result.code === "invalid_input";
