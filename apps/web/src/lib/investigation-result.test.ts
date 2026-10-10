import { describe, expect, it } from "vitest";
import { evidenceLinks, GAP_TEXT, type InvestigationResult } from "./investigation-result.ts";

const result = {
  evidence: [
    {
      ref: "call:1",
      tool: "get_finding_risk",
      kind: "finding",
      targets: [{ findingId: "f-1", purl: "pkg:pypi/django@3.0", version: "3.0" }],
    },
    {
      ref: "call:2",
      tool: "list_related_findings",
      kind: "related_finding",
      targets: [
        { findingId: "f-2", purl: "pkg:pypi/django@3.1", version: "3.1" },
        { findingId: "f-3", purl: "pkg:pypi/other@1", version: "1" },
      ],
    },
    {
      ref: "call:3",
      tool: "get_dependency_occurrences",
      kind: "dependency_occurrence",
      targets: [{ purl: "pkg:pypi/django@3.0", version: "3.0" }],
    },
    { ref: "call:4", tool: "lookup_advisory", kind: "advisory", advisoryId: "GHSA-aaaa" },
  ],
} as InvestigationResult["result"];

describe("evidenceLinks", () => {
  it("links findings, lists occurrences without a link, and names advisories", () => {
    expect(evidenceLinks(result, ["call:1", "call:2", "call:3", "call:4"])).toEqual([
      { label: "pkg:pypi/django@3.0", findingId: "f-1" },
      { label: "pkg:pypi/django@3.1", findingId: "f-2" },
      { label: "pkg:pypi/other@1", findingId: "f-3" },
      { label: "pkg:pypi/django@3.0" },
      { label: "Advisory GHSA-aaaa" },
    ]);
  });

  it("drops a reference the API did not resolve instead of inventing a link", () => {
    expect(evidenceLinks(result, ["call:9"])).toEqual([]);
  });
});

describe("GAP_TEXT", () => {
  it("words every gap code the API can emit", () => {
    expect(Object.keys(GAP_TEXT).toSorted()).toEqual(
      [
        "advisory_not_found",
        "finding_resolved",
        "no_cvss",
        "no_tool_evidence",
        "occurrences_not_checked",
        "related_findings_not_checked",
        "result_truncated",
        "weak_match",
      ].toSorted(),
    );
  });
});
