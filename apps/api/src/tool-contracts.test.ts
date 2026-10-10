import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isToolName, loadToolValidators, TOOL_NAMES } from "./tool-contracts.ts";

const dir = new URL("../../../packages/contracts/ai-tools/", import.meta.url);
const validators = loadToolValidators();

describe("tool contracts", () => {
  it("has one versioned contract file per tool and nothing else", () => {
    expect(readdirSync(dir).toSorted()).toEqual(TOOL_NAMES.map((t) => `${t}.v1.json`).toSorted());
    for (const tool of TOOL_NAMES) {
      const contract = JSON.parse(readFileSync(new URL(`${tool}.v1.json`, dir), "utf8"));
      expect(contract).toMatchObject({ tool, version: 1 });
      expect(contract.description.length).toBeGreaterThan(20);
    }
  });

  it("forbids scope and any unknown argument on every tool", () => {
    for (const tool of TOOL_NAMES) {
      const base =
        tool === "list_related_findings"
          ? { relation: "same_package" }
          : tool === "lookup_advisory"
            ? { id: "CVE-2020-1" }
            : {};
      expect(validators[tool].arguments(base), tool).toBe(true);
      for (const extra of ["orgId", "projectId", "findingId", "investigationId"]) {
        expect(validators[tool].arguments({ ...base, [extra]: "x" }), `${tool} ${extra}`).toBe(
          false,
        );
      }
    }
  });

  it("checks argument bounds", () => {
    const list = validators.list_related_findings.arguments;
    expect(list({ relation: "same_package", limit: 10 })).toBe(true);
    expect(list({ relation: "same_package", limit: 11 })).toBe(false);
    expect(list({ relation: "same_package", limit: 1.5 })).toBe(false);
    expect(validators.lookup_advisory.arguments({ id: "GHSA-xxxx-yyyy-zzzz" })).toBe(true);
    expect(validators.lookup_advisory.arguments({ id: "a b" })).toBe(false);
  });

  it("rejects a result with an extra field, so a handler cannot leak unplanned data", () => {
    expect(
      validators.get_dependency_occurrences.result({
        importId: "i",
        importedAt: "t",
        occurrences: [],
      }),
    ).toBe(true);
    expect(
      validators.get_dependency_occurrences.result({
        importId: "i",
        importedAt: "t",
        occurrences: [],
        orgId: "o",
      }),
    ).toBe(false);
  });

  it("recognizes exactly the four tool names", () => {
    expect(TOOL_NAMES.every(isToolName)).toBe(true);
    expect(isToolName("run_sql")).toBe(false);
    expect(isToolName("constructor")).toBe(false);
  });
});
