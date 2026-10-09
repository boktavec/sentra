import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";

export type FindingStatus = "open" | "resolved" | "all";
export type FindingSeverity =
  "all" | "critical" | "high" | "medium" | "low" | "none" | "unavailable";

export type FindingSort = "priority" | "severity" | "newest";
export type FindingPriorityFilter = "all" | "p1" | "p2" | "p3" | "p4";

export interface FindingFilters {
  status: FindingStatus;
  severity: FindingSeverity;
  sort: FindingSort;
  priority: FindingPriorityFilter;
}

/** Sentra priority as computed by the API (see packages/contracts/models.md); the web never re-decides it. */
export interface FindingPriority {
  tier: "P1" | "P2" | "P3" | "P4";
  modelVersion: number;
  baseReason: "kev_listed" | "cvss_high" | "cvss_medium" | "cvss_unavailable" | "cvss_low";
  scopeAdjusted: boolean;
  factors: {
    kev: "listed" | "not_listed" | "unavailable";
    cvss: { score: number | null; category: string };
    scope: "required" | "optional" | "excluded";
    matchQuality: "confirmed" | "unverifiable";
  };
}

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
  priority: FindingPriority;
}

interface FindingPage {
  items: Finding[];
  nextCursor: string | null;
}

export function listFindings(
  orgId: string,
  projectSlug: string,
  filters: FindingFilters,
  cursor?: string,
) {
  const params = new URLSearchParams({ ...filters, limit: "50" });
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
  priority: FindingPriority;
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
