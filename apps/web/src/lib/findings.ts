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

export interface FindingAffected {
  packageName: string;
  versions: string[];
  versionsTruncated: boolean;
  ranges: { type: string; events: { type: string; version: string }[] }[];
}

export interface FindingMember {
  id: string;
  status: "open" | "resolved";
  resolvedReason: string | null;
  resolvedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  importId: string;
  matchQuality: "confirmed" | "unverifiable";
  matchReason: string | null;
  matcherVersion: number;
  evidence: unknown;
  advisory: {
    id: string;
    source: string;
    sourceId: string;
    aliases: string[];
    summary: string | null;
    details: string | null;
    detailsTruncated: boolean;
    publishedAt: string | null;
    modifiedAt: string;
    withdrawnAt: string | null;
    cvssScore: number | null;
    cvssVersion: string | null;
    refs: { type: string | null; url: string | null }[];
    refsTruncated: boolean;
    affected: FindingAffected[];
  };
}

export interface KevEntry {
  cveId: string;
  vendorProject: string | null;
  product: string | null;
  name: string | null;
  dateAdded: string;
  dueDate: string | null;
  knownRansomwareUse: string | null;
  requiredAction: string | null;
  catalogVersion: string;
}

export interface FindingDetail {
  id: string;
  purl: string;
  version: string;
  ecosystem: string;
  scope: string;
  status: "open" | "resolved";
  firstSeenAt: string;
  lastSeenAt: string;
  groupId: string | null;
  vulnerability: Finding["vulnerability"];
  kevStatus: Finding["kevStatus"];
  kev: KevEntry[] | null;
  members: FindingMember[];
  membersTruncated: boolean;
}

export function getFinding(orgId: string, projectSlug: string, findingId: string) {
  return callApi((token) =>
    apiGet<FindingDetail>(
      `/v1/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectSlug)}/findings/${encodeURIComponent(findingId)}`,
      token,
    ),
  );
}
