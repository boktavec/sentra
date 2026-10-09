import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";

export type FindingStatus = "open" | "resolved" | "all";
export type FindingSeverity =
  "all" | "critical" | "high" | "medium" | "low" | "none" | "unavailable";

export interface Finding {
  id: string;
  purl: string;
  version: string;
  status: "open" | "resolved";
  matchQuality: "confirmed" | "unverifiable";
  firstSeenAt: string;
  vulnerability: {
    id: string;
    source: string;
    sourceId: string;
    aliases: string[];
    summary: string | null;
    cvssScore: number | null;
    cvssVersion: string | null;
    severityCategory: string;
    cvssSource: { source: string; sourceId: string } | null;
  };
  sources: { id: string; source: string; sourceId: string; aliases: string[] }[];
  kevStatus: "listed" | "not_listed" | "unavailable";
}

interface FindingPage {
  items: Finding[];
  nextCursor: string | null;
}

export function listFindings(
  orgId: string,
  projectSlug: string,
  status: FindingStatus,
  severity: FindingSeverity,
  cursor?: string,
) {
  const params = new URLSearchParams({ status, severity, sort: "severity", limit: "50" });
  if (cursor) params.set("cursor", cursor);
  return callApi((token) =>
    apiGet<FindingPage>(
      `/v1/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectSlug)}/findings?${params}`,
      token,
    ),
  );
}
