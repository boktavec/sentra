import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";

export interface Finding {
  id: string;
  purl: string;
  version: string;
  status: "open" | "resolved";
  matchQuality: "confirmed" | "unverifiable";
  vulnerability: { source: string; sourceId: string; summary: string | null };
}

export interface Investigation {
  id: string;
  findingId: string;
  status: "queued" | "running" | "completed" | "failed";
  failureCode: string | null;
  attempts: number;
  modelId: string;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const findingsPath = (orgId: string, projectSlug: string) =>
  `/v1/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectSlug)}/findings`;

export const investigationsPath = (orgId: string, projectSlug: string, findingId: string) =>
  `${findingsPath(orgId, projectSlug)}/${encodeURIComponent(findingId)}/investigations`;

export const listInvestigationFindings = (orgId: string, projectSlug: string, cursor?: string) =>
  callApi((token) =>
    apiGet<Page<Finding>>(
      `${findingsPath(orgId, projectSlug)}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      token,
    ),
  );
