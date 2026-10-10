import { describe, expect, it } from "vitest";
import {
  buildResult,
  deriveGaps,
  loadResultContract,
  type LedgerCall,
  type RunFacts,
  type ViolationCode,
} from "./investigation-result.ts";

const contract = loadResultContract();
const NOW = new Date("2026-10-09T12:00:00Z");
const ATTEMPT = 2;

const risk = (over: { status?: string; cvss?: number | null; match?: string } = {}) => ({
  finding: {
    id: "f-1",
    purl: "pkg:pypi/django@3.0",
    version: "3.0",
    ecosystem: "PyPI",
    scope: "required",
    status: over.status ?? "open",
    resolvedReason: null,
    matchQuality: over.match ?? "confirmed",
    matchReason: null,
    evidence: null,
    firstSeenAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-02T00:00:00Z",
  },
  priority: {
    tier: "P2",
    modelVersion: 1,
    baseReason: "cvss_high",
    scopeAdjusted: false,
    factors: {},
  },
  kevStatus: "listed",
  advisory: {
    source: "osv",
    sourceId: "GHSA-aaaa",
    aliases: ["CVE-2020-1"],
    summary: "SQL injection",
    cvssScore: over.cvss === undefined ? 9.8 : over.cvss,
    cvssVersion: "3.1",
  },
});

let n = 0;
const call = (tool: LedgerCall["tool"], over: Partial<LedgerCall> = {}): LedgerCall => ({
  callNo: ++n,
  attempt: ATTEMPT,
  tool,
  outcome: "ok",
  truncated: false,
  result: null,
  ...over,
});

/** The ledger of a thorough attempt: calls 1 to 4, all ok. */
function fullLedger(riskOver: Parameters<typeof risk>[0] = {}): LedgerCall[] {
  n = 0;
  return [
    call("get_finding_risk", { result: risk(riskOver) }),
    call("list_related_findings", {
      result: { items: [{ findingId: "f-2", purl: "pkg:pypi/django@3.1", version: "3.1" }] },
    }),
    call("get_dependency_occurrences", {
      result: { occurrences: [{ purl: "pkg:pypi/django@3.0", version: "3.0" }] },
    }),
    call("lookup_advisory", { result: { advisory: { sourceId: "GHSA-aaaa" } } }),
  ];
}

const run: RunFacts = {
  findingId: "f-1",
  snapshot: {
    finding: {
      purl: "pkg:pypi/django@3.0",
      version: "3.0",
      ecosystem: "PyPI",
      scope: "required",
      matchQuality: "confirmed",
    },
    advisory: { source: "osv", sourceId: "GHSA-aaaa", aliases: [], summary: null },
  },
  modelId: "test-model",
  promptVersion: 3,
  attempt: ATTEMPT,
};

const answer = (over: Record<string, unknown> = {}) => ({
  summary: "Django is vulnerable to SQL injection.",
  tenantImpact: "Your app uses Django 3.0 in production.",
  nextSteps: ["Upgrade Django."],
  claims: [{ text: "The finding is a confirmed match.", evidence: ["call:1", "call:4"] }],
  uncertainties: ["Exploitability in this deployment is unknown."],
  ...over,
});

const build = (input: unknown, ledger = fullLedger()) =>
  buildResult(contract, input, ledger, run, NOW);

function violationsOf(input: unknown, ledger?: LedgerCall[]): ViolationCode[] {
  const out = build(input, ledger);
  if (out.ok) throw new Error("expected a rejection");
  return out.violations;
}

describe("buildResult", () => {
  it("stores the model's explanation next to API-written facts, evidence and gaps", () => {
    const out = build(answer());
    expect(out.ok).toBe(true);
    const result = (out as { value: { evidence: unknown } }).value;
    expect(result).toMatchObject({
      summary: "Django is vulnerable to SQL injection.",
      modelId: "test-model",
      promptVersion: 3,
      generatedAt: NOW.toISOString(),
      facts: {
        source: "get_finding_risk",
        findingId: "f-1",
        status: "open",
        kevStatus: "listed",
        priority: { tier: "P2" },
        advisory: { sourceId: "GHSA-aaaa", cvssScore: 9.8 },
      },
      gaps: [],
    });
    expect(result.evidence).toEqual([
      {
        ref: "call:1",
        tool: "get_finding_risk",
        kind: "finding",
        targets: [{ findingId: "f-1", purl: "pkg:pypi/django@3.0", version: "3.0" }],
      },
      { ref: "call:4", tool: "lookup_advisory", kind: "advisory", advisoryId: "GHSA-aaaa" },
    ]);
  });

  it("resolves related findings and occurrences, only for the calls that were cited", () => {
    const out = build(
      answer({ claims: [{ text: "x", evidence: ["call:2", "call:3", "call:3"] }] }),
    ) as { value: { evidence: { kind: string }[]; claims: { evidence: string[] }[] } };
    expect(out.value.evidence.map((e) => e.kind)).toEqual([
      "related_finding",
      "dependency_occurrence",
    ]);
    expect(out.value.claims[0]!.evidence).toEqual(["call:2", "call:3"]);
  });

  it("takes facts from the ledger, never from the model's prose", () => {
    const out = build(
      answer({ summary: "This is KEV listed with CVSS 10 and priority P1." }),
      fullLedger({ cvss: 4.3 }),
    ) as { value: { facts: { advisory: { cvssScore: number }; kevStatus: string } } };
    expect(out.value.facts.advisory.cvssScore).toBe(4.3);
    expect(out.value.facts.kevStatus).toBe("listed");
  });

  it("falls back to the snapshot, and says so, when get_finding_risk was not called", () => {
    n = 0;
    const ledger = [call("lookup_advisory", { result: { advisory: { sourceId: "GHSA-aaaa" } } })];
    const out = build(answer({ claims: [{ text: "x", evidence: ["call:1"] }] }), ledger) as {
      value: { facts: Record<string, unknown>; gaps: string[] };
    };
    expect(out.value.facts).toMatchObject({
      source: "snapshot",
      status: null,
      priority: null,
      kevStatus: null,
    });
    expect(out.value.gaps).toContain("no_cvss");
  });

  it("rejects a result that outgrows the stored size", () => {
    const claims = Array.from({ length: 12 }, () => ({
      text: "😀".repeat(400),
      evidence: ["call:1"],
    }));
    const big = answer({ summary: "😀".repeat(1200), tenantImpact: "😀".repeat(1200), claims });
    expect(violationsOf(big)).toEqual(["schema_invalid"]);
  });
});

describe("violations", () => {
  const cases: [string, unknown, ViolationCode[]][] = [
    ["a non-object", "not json", ["schema_invalid"]],
    ["an array", [], ["schema_invalid"]],
    [
      "a missing field",
      Object.fromEntries(Object.entries(answer()).filter(([key]) => key !== "summary")),
      ["schema_invalid"],
    ],
    ["an over-long summary", answer({ summary: "x".repeat(1201) }), ["schema_invalid"]],
    ["an unknown field", answer({ extra: 1 }), ["schema_invalid"]],
    [
      "a malformed reference",
      answer({ claims: [{ text: "x", evidence: ["call:0"] }] }),
      ["schema_invalid"],
    ],
    ["no claims", answer({ claims: [] }), ["schema_invalid"]],
    [
      "more than 4 references",
      answer({
        claims: [{ text: "x", evidence: ["call:1", "call:2", "call:3", "call:4", "call:1"] }],
      }),
      ["schema_invalid"],
    ],
    ["a supplied fact", answer({ facts: { priority: "P4" } }), ["forbidden_field"]],
    ["a supplied gap list", answer({ gaps: [] }), ["forbidden_field"]],
    ["a supplied model id", answer({ modelId: "other" }), ["forbidden_field"]],
    ["a supplied evidence list", answer({ evidence: [] }), ["forbidden_field"]],
    [
      "a claim with no references",
      answer({ claims: [{ text: "x", evidence: [] }] }),
      ["uncited_claim"],
    ],
    [
      "a call that does not exist",
      answer({ claims: [{ text: "x", evidence: ["call:99"] }] }),
      ["unknown_evidence_ref"],
    ],
    [
      "no uncertainties and no reason",
      answer({ uncertainties: [] }),
      ["missing_uncertainty_reason"],
    ],
  ];
  it.each(cases)("rejects %s", (_name, input, expected) => {
    expect(violationsOf(input)).toEqual(expected);
  });

  it("accepts no uncertainties when a reason is given", () => {
    expect(
      build(answer({ uncertainties: [], noUncertaintyReason: "Every fact came from a tool." })).ok,
    ).toBe(true);
  });

  it("rejects a call that failed", () => {
    const ledger = fullLedger();
    ledger[3] = { ...ledger[3]!, outcome: "not_found", result: null };
    expect(violationsOf(answer(), ledger)).toEqual(["evidence_not_ok"]);
  });

  it("rejects a number that exists only in an earlier attempt", () => {
    const ledger = fullLedger();
    const earlier: LedgerCall = { ...ledger[0]!, attempt: 1, callNo: 5 };
    expect(
      violationsOf(answer({ claims: [{ text: "x", evidence: ["call:5"] }] }), [...ledger, earlier]),
    ).toEqual(["cross_attempt_ref"]);
  });

  it("does not treat a token exchange (never numbered) as citable", () => {
    expect(violationsOf(answer({ claims: [{ text: "x", evidence: ["call:5"] }] }))).toEqual([
      "unknown_evidence_ref",
    ]);
  });

  it("reports each distinct violation once", () => {
    const input = answer({
      uncertainties: [],
      claims: [
        { text: "x", evidence: ["call:98", "call:99"] },
        { text: "y", evidence: [] },
      ],
    });
    expect(violationsOf(input)).toEqual([
      "missing_uncertainty_reason",
      "unknown_evidence_ref",
      "uncited_claim",
    ]);
  });
});

describe("gap rules", () => {
  const gapsFor = (ledger: LedgerCall[]) => {
    const out = buildResult(
      contract,
      answer({ claims: [{ text: "x", evidence: ["call:1"] }] }),
      ledger,
      run,
      NOW,
    );
    return (out as { value: { gaps: string[] } }).value.gaps;
  };
  const replace = (index: number, over: Partial<LedgerCall>) => {
    const ledger = fullLedger();
    ledger[index] = { ...ledger[index]!, ...over };
    return ledger;
  };

  it("has no gaps when everything was checked and found", () => {
    expect(gapsFor(fullLedger())).toEqual([]);
  });

  const cases: [string, LedgerCall[], string[]][] = [
    [
      "advisory_not_found",
      replace(3, { outcome: "not_found", result: null }),
      ["advisory_not_found"],
    ],
    ["result_truncated", replace(1, { truncated: true }), ["result_truncated"]],
    ["no_cvss", fullLedger({ cvss: null }), ["no_cvss"]],
    ["weak_match", fullLedger({ match: "unverifiable" }), ["weak_match"]],
    ["finding_resolved", fullLedger({ status: "resolved" }), ["finding_resolved"]],
    [
      "related_findings_not_checked",
      fullLedger().filter((c) => c.tool !== "list_related_findings"),
      ["related_findings_not_checked"],
    ],
    [
      "occurrences_not_checked",
      fullLedger().filter((c) => c.tool !== "get_dependency_occurrences"),
      ["occurrences_not_checked"],
    ],
  ];
  it.each(cases)("derives %s", (_code, ledger, expected) => {
    expect(gapsFor(ledger)).toEqual(expected);
  });

  it("derives no_tool_evidence when no call succeeded", () => {
    const facts = {
      advisory: { cvssScore: 5 },
      matchQuality: "confirmed",
      status: "open",
    } as never;
    const failed: LedgerCall[] = [call("get_finding_risk", { outcome: "error" })];
    expect(deriveGaps(failed, facts)).toEqual([
      "no_tool_evidence",
      "related_findings_not_checked",
      "occurrences_not_checked",
    ]);
  });

  it("ignores another attempt's calls", () => {
    const ledger = [
      ...fullLedger().map((c) => ({ ...c, attempt: 1 })),
      ...fullLedger()
        .slice(0, 1)
        .map((c) => ({ ...c, callNo: 1 })),
    ];
    expect(gapsFor(ledger)).toEqual(["related_findings_not_checked", "occurrences_not_checked"]);
  });
});
