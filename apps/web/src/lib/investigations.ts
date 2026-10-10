import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";
import type { Finding } from "./findings.ts";
export type { Finding } from "./findings.ts";

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

export type { InvestigationResult } from "./investigation-result.ts";

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
      `${findingsPath(orgId, projectSlug)}?status=all&severity=all&sort=newest&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      token,
    ),
  );
