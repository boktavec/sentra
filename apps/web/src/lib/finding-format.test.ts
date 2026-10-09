import { describe, expect, it } from "vitest";
import {
  explainEvidence,
  explainPriority,
  formatDate,
  kevLabel,
  priorityLabel,
  resolvedReasonLabel,
  safeHref,
  severityLabel,
} from "./finding-format.ts";
import type { FindingPriority } from "./findings.ts";

describe("safeHref", () => {
  it.each(["https://example.test/a?b=1", "http://example.test", "HTTPS://EXAMPLE.TEST/x"])(
    "keeps the http(s) link %s",
    (url) => {
      expect(safeHref(url)).toMatch(/^https?:\/\//);
    },
  );
  it("normalizes a link with surrounding whitespace instead of trusting the raw string", () => {
    expect(safeHref("  https://example.test/a ")).toBe("https://example.test/a");
  });
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "\tjava\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.test/x",
    "//example.test/x",
    "/relative/path",
    "not a url",
    "",
    null,
  ])("refuses %j", (url) => {
    expect(safeHref(url)).toBeNull();
  });
});

const range = (events: { type: string; version: string }[]) => ({
  package: "trac",
  dependencyVersion: "1.0.0",
  rule: "range",
  comparator: "pep440",
  range: { type: "ECOSYSTEM", events },
});

describe("explainEvidence", () => {
  it("explains an explicit version match", () => {
    const evidence = {
      package: "trac",
      dependencyVersion: "1.0.0",
      rule: "explicit_version",
      comparator: null,
    };
    expect(explainEvidence(evidence, "confirmed", null)).toEqual({
      summary: "Version 1.0.0 of trac is listed in the advisory's affected versions.",
      facts: [],
    });
  });

  it("explains a range match and labels the fixed version as the advisory's, not Sentra's advice", () => {
    const result = explainEvidence(
      range([
        { type: "introduced", version: "0" },
        { type: "fixed", version: "1.2.0" },
      ]),
      "confirmed",
      null,
    );
    expect(result?.summary).toContain("falls inside an affected range");
    expect(result?.facts).toEqual([
      { label: "Versions compared as", value: "pep440" },
      { label: "Introduced in", value: "the first release (0)" },
      { label: "Fixed in (per advisory range)", value: "1.2.0" },
    ]);
  });

  it("shows no fixed line when the range has no fixed event", () => {
    const result = explainEvidence(
      range([
        { type: "introduced", version: "1.0.0" },
        { type: "last_affected", version: "1.5.0" },
      ]),
      "confirmed",
      null,
    );
    expect(result?.facts.map((f) => f.label)).toEqual([
      "Versions compared as",
      "Introduced in",
      "Last affected",
    ]);
  });

  it.each([
    ["version_unparseable", "could not read version"],
    ["range_malformed", "is malformed"],
    ["ecosystem_unsupported", "no version ordering"],
  ])("says plainly that an unverifiable %s match is uncertain", (reason, text) => {
    const result = explainEvidence(
      range([{ type: "introduced", version: "0" }]),
      "unverifiable",
      reason,
    );
    expect(result?.summary).toContain(text);
    expect(result?.summary).toContain("cannot tell");
    expect(result?.summary).not.toContain("falls inside");
  });

  it("explains an advisory with no version data as unverifiable", () => {
    const evidence = {
      package: "trac",
      dependencyVersion: "1.0.0",
      rule: "no_version_data",
      comparator: null,
    };
    expect(explainEvidence(evidence, "unverifiable", "no_version_data")?.summary).toContain(
      "gives no versions or ranges",
    );
  });

  it.each([
    ["an unknown rule", { package: "p", dependencyVersion: "1", rule: "fuzzy" }, "confirmed", null],
    ["a missing package", { dependencyVersion: "1", rule: "explicit_version" }, "confirmed", null],
    ["non-object evidence", "oops", "confirmed", null],
    ["null evidence", null, "confirmed", null],
    ["an array", [], "confirmed", null],
    [
      "a range without events",
      { package: "p", dependencyVersion: "1", rule: "range" },
      "confirmed",
      null,
    ],
    [
      "malformed events",
      { package: "p", dependencyVersion: "1", rule: "range", range: { events: [{ type: 1 }] } },
      "confirmed",
      null,
    ],
    [
      "an unknown unverifiable reason",
      range([{ type: "introduced", version: "0" }]),
      "unverifiable",
      "brand_new_reason",
    ],
    [
      "a confirmed match that carries a reason",
      range([{ type: "introduced", version: "0" }]),
      "confirmed",
      "range_malformed",
    ],
    [
      "a rule that cannot be unverifiable for this reason",
      { package: "p", dependencyVersion: "1", rule: "explicit_version" },
      "unverifiable",
      "version_unparseable",
    ],
  ] as const)("falls back to raw JSON for %s", (_name, evidence, quality, reason) => {
    expect(explainEvidence(evidence, quality, reason)).toBeNull();
  });
});

describe("labels", () => {
  it("never claims 'not exploited' without catalog data", () => {
    expect(kevLabel("unavailable")).toBe("Exploitation data unavailable");
    expect(kevLabel("not_listed")).toBe("Not listed in ingested CISA KEV catalog");
    expect(kevLabel("listed")).toBe("In CISA KEV");
  });
  it("labels severity or says it is unavailable", () => {
    expect(
      severityLabel({ cvssScore: 9.8, cvssVersion: "3.1", severityCategory: "critical" }),
    ).toBe("Critical 9.8 (CVSS 3.1)");
    expect(
      severityLabel({
        cvssScore: null,
        cvssVersion: null,
        severityCategory: "unavailable",
      }),
    ).toBe("Severity unavailable");
  });
  it("names resolved reasons and tolerates unknown ones", () => {
    expect(resolvedReasonLabel("dependency_removed")).toContain("no longer in the project");
    expect(resolvedReasonLabel("future_reason")).toBe("future_reason");
    expect(resolvedReasonLabel(null)).toBe("unknown reason");
  });
  it("formats the UTC date", () => {
    expect(formatDate("2026-02-03T23:59:59.000Z")).toBe("2026-02-03");
  });
});

describe("priority labels", () => {
  const priority = (overrides: Partial<FindingPriority> = {}, factors = {}): FindingPriority => ({
    tier: "P2",
    modelVersion: 1,
    baseReason: "cvss_high",
    scopeAdjusted: false,
    factors: {
      kev: "not_listed",
      cvss: { score: 7.5, category: "high" },
      scope: "required",
      matchQuality: "confirmed",
      ...factors,
    },
    ...overrides,
  });

  it("names the tier and the model version", () => {
    expect(priorityLabel(priority())).toBe("P2 (model v1)");
  });

  it.each([
    ["kev_listed", { kev: "listed" }, "Listed in CISA KEV: base P1"],
    ["cvss_high", {}, "High or critical severity (CVSS 7.5): base P2"],
    [
      "cvss_medium",
      { cvss: { score: 5.5, category: "medium" } },
      "Medium severity (CVSS 5.5): base P3",
    ],
    [
      "cvss_unavailable",
      { cvss: { score: null, category: "unavailable" } },
      "Severity unavailable: treated as P3",
    ],
    ["cvss_low", { cvss: { score: 2, category: "low" } }, "Low severity (CVSS 2.0): base P4"],
  ] as const)("explains the %s base reason first", (baseReason, factors, sentence) => {
    expect(explainPriority(priority({ baseReason }, factors))[0]).toBe(sentence);
  });

  it("says exploitation data is unavailable, never that the vulnerability is not exploited", () => {
    const reasons = explainPriority(priority({}, { kev: "unavailable" }));
    expect(reasons).toContain("Exploitation data unavailable");
    expect(reasons.join(" ")).not.toMatch(/not exploited/i);
  });

  it("states a not-listed result as a fact about the ingested catalog", () => {
    expect(explainPriority(priority())).toContain("Not listed in ingested CISA KEV catalog");
  });

  it("does not repeat the KEV listing as a second reason", () => {
    expect(explainPriority(priority({ baseReason: "kev_listed" }, { kev: "listed" }))).toEqual([
      "Listed in CISA KEV: base P1",
    ]);
  });

  it("explains a lowered tier, and a scope that could not lower it further", () => {
    expect(explainPriority(priority({ scopeAdjusted: true }, { scope: "excluded" }))).toContain(
      "Scope excluded: lowered one tier",
    );
    expect(
      explainPriority(
        priority(
          { baseReason: "cvss_low", tier: "P4" },
          { scope: "optional", cvss: { score: 2, category: "low" } },
        ),
      ),
    ).toContain("Scope optional: already the lowest tier");
  });

  it("adds nothing for a required scope and reports an unverifiable match without changing the tier", () => {
    const reasons = explainPriority(priority({}, { matchQuality: "unverifiable" }));
    expect(reasons.some((r) => r.startsWith("Scope"))).toBe(false);
    expect(reasons).toContain("Version could not be verified: tier unchanged");
  });
});
