// The stored result of a completed investigation (packages/contracts/ai-tools/investigation-result.v1.json).
// `facts`, `evidence`, `gaps` and the model fields are separate on purpose: the API writes the first three
// from retrieved data, the model writes the rest, and the page labels them differently.
import type { FindingPriority } from "./findings.ts";

export const GAP_TEXT = {
  advisory_not_found: "The advisory was not found in the intelligence data.",
  result_truncated: "A tool result was cut to fit its size limit, so some data is missing.",
  no_cvss: "No CVSS score is available for this advisory.",
  weak_match: "The dependency match could not be verified against the advisory's version data.",
  finding_resolved: "This finding has been resolved since the investigation started.",
  no_tool_evidence: "No tool call succeeded, so nothing here was checked against current data.",
  related_findings_not_checked: "Related findings in this project were not checked.",
  occurrences_not_checked: "Other versions of this dependency in the SBOM were not checked.",
} as const;
export type GapCode = keyof typeof GAP_TEXT;

export interface ResultTarget {
  findingId?: string;
  purl: string;
  version: string;
}

export interface ResultEvidence {
  ref: string;
  tool: string;
  kind: "finding" | "related_finding" | "dependency_occurrence" | "advisory";
  advisoryId?: string;
  targets?: ResultTarget[];
}

export interface ResultFacts {
  /** `snapshot` when get_finding_risk was not called: status, KEV and priority are then unknown. */
  source: "get_finding_risk" | "snapshot";
  findingId: string;
  purl: string;
  version: string;
  ecosystem: string;
  scope: string;
  status: "open" | "resolved" | null;
  matchQuality: string;
  advisory: {
    source: string;
    sourceId: string;
    aliases: string[];
    summary: string | null;
    cvssScore: number | null;
    cvssVersion: string | null;
  };
  kevStatus: "listed" | "not_listed" | "unavailable" | null;
  priority: FindingPriority | null;
}

export interface InvestigationResult {
  investigationId: string;
  schemaVersion: number;
  createdAt: string;
  result: {
    summary: string;
    tenantImpact: string;
    nextSteps: string[];
    claims: { text: string; evidence: string[] }[];
    uncertainties: string[];
    noUncertaintyReason?: string;
    facts: ResultFacts;
    evidence: ResultEvidence[];
    gaps: GapCode[];
    modelId: string;
    promptVersion: number;
    generatedAt: string;
  };
}

export interface EvidenceLink {
  label: string;
  /** Set for evidence that has a page in Sentra (a finding); otherwise the label is plain text. */
  findingId?: string;
}

/** What a claim's `call:<n>` references point at, as links and labels. A reference the API did not resolve is dropped. */
export function evidenceLinks(
  result: InvestigationResult["result"],
  refs: string[],
): EvidenceLink[] {
  const byRef = new Map(result.evidence.map((e) => [e.ref, e]));
  return refs.flatMap((ref) => {
    const entry = byRef.get(ref);
    if (!entry) return [];
    if (entry.kind === "advisory") return [{ label: `Advisory ${entry.advisoryId}` }];
    // A purl already carries its version.
    return (entry.targets ?? []).map(({ findingId, purl }) => ({
      label: purl,
      ...(findingId ? { findingId } : {}),
    }));
  });
}
