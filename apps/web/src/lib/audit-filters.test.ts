import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KNOWN_AUDIT_ACTIONS } from "./audit-actions.ts";
import {
  hasActiveFilters,
  normalizeInstant,
  parseAuditFilters,
  rawAuditQuery,
  utcQueryFromForm,
} from "./audit-filters.ts";

function toFormData(values: Record<string, string>) {
  const form = new FormData();

  for (const [name, value] of Object.entries(values)) form.set(name, value);

  return form;
}

const originalTz = process.env["TZ"];

// The From/To conversion reads the process zone: Amsterdam is UTC+2 in July.
beforeAll(() => {
  process.env["TZ"] = "Europe/Amsterdam";
});

afterAll(() => {
  if (originalTz === undefined) delete process.env["TZ"];
  else process.env["TZ"] = originalTz;
});

const ACTOR = "3f2b8c1e-9d4a-4b7e-8c21-5a6f0d3e1b94";

describe("normalizeInstant", () => {
  it("keeps a strict UTC ISO value", () => {
    expect(normalizeInstant("2026-03-01T10:00:05Z")).toBe("2026-03-01T10:00:05Z");
    expect(normalizeInstant("2026-03-01T10:00:05.250Z")).toBe("2026-03-01T10:00:05.250Z");
  });

  it("reads a bare no-JS value (minutes or seconds) as UTC", () => {
    expect(normalizeInstant("2026-03-01T10:00")).toBe("2026-03-01T10:00:00Z");
    expect(normalizeInstant("2026-03-01T10:00:05")).toBe("2026-03-01T10:00:05Z");
  });

  it.each([
    "",
    "yesterday",
    "2026-03-01",
    "2026-03-01T10:00:00+01:00",
    "2026-02-31T10:00:00Z",
    "2026-03-01T25:00:00Z",
  ])("rejects %j", (value) => {
    expect(normalizeInstant(value)).toBeUndefined();
  });
});

describe("parseAuditFilters", () => {
  it("accepts an empty query", () => {
    expect(parseAuditFilters({})).toEqual({ filters: {}, issues: [] });
  });

  it("normalizes valid filters and trims text", () => {
    const { filters, issues } = parseAuditFilters({
      from: "2026-03-01T10:00",
      to: "2026-03-02T10:00:00Z",
      actorId: ` ${ACTOR.toUpperCase()} `,
      action: " org.created ",
      result: "failed",
    });

    expect(issues).toEqual([]);
    expect(filters).toEqual({
      from: "2026-03-01T10:00:00Z",
      to: "2026-03-02T10:00:00Z",
      actorId: ACTOR,
      action: "org.created",
      result: "failed",
    });
  });

  it("ignores empty values and an unknown result", () => {
    expect(parseAuditFilters({ from: "", action: "", actorId: " ", result: "bogus" })).toEqual({
      filters: {},
      issues: [],
    });
  });

  it("flags From equal to or after To on the To field", () => {
    for (const to of ["2026-03-01T10:00:00Z", "2026-03-01T09:00:00Z"]) {
      const { issues } = parseAuditFilters({ from: "2026-03-01T10:00:00Z", to });

      expect(issues).toEqual([{ field: "to", message: "From must be earlier than To." }]);
    }
  });

  it("flags an unparsable date, drops it, and still validates the rest", () => {
    const { filters, issues } = parseAuditFilters({ from: "soon", to: "2026-03-01T10:00:00Z" });

    expect(issues).toEqual([{ field: "from", message: "Enter a valid date and time for From." }]);
    expect(filters).toEqual({ to: "2026-03-01T10:00:00Z" });
  });

  it("flags a non-UUID actor ID but keeps the value for the form", () => {
    const { filters, issues } = parseAuditFilters({ actorId: "not-a-uuid" });

    expect(issues.map((issue) => issue.field)).toEqual(["actorId"]);
    expect(filters.actorId).toBe("not-a-uuid");
  });

  it("allows an action of 100 characters and flags 101", () => {
    expect(parseAuditFilters({ action: "a".repeat(100) }).issues).toEqual([]);
    expect(parseAuditFilters({ action: "a".repeat(101) }).issues).toEqual([
      { field: "action", message: "Action must be 1 to 100 characters." },
    ]);
  });

  it("accepts an action the web does not know", () => {
    expect(parseAuditFilters({ action: "future.thing" }).issues).toEqual([]);
  });

  it("reports every problem at once without echoing user input", () => {
    const { issues } = parseAuditFilters({ from: "x", actorId: "<script>" });

    expect(issues.map((issue) => issue.field)).toEqual(["from", "actorId"]);
    expect(issues.some((issue) => issue.message.includes("<script>"))).toBe(false);
  });
});

describe("hasActiveFilters", () => {
  it("is false for an empty query and true when any filter is present, valid or not", () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ action: "" })).toBe(false);
    expect(hasActiveFilters({ from: "garbage" })).toBe(true);
  });
});

describe("rawAuditQuery", () => {
  it("takes the first value of a repeated parameter", () => {
    expect(rawAuditQuery({ action: ["a", "b"], cursor: "c" })).toMatchObject({
      action: "a",
      cursor: "c",
    });
  });
});

describe("utcQueryFromForm", () => {
  it("converts From and To to UTC, keeps other fields, and omits empty ones", () => {
    const query = utcQueryFromForm(
      toFormData({
        from: "2026-07-15T12:00:05",
        to: "",
        actorId: "",
        action: "org.created",
        result: "",
      }),
    );

    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      from: "2026-07-15T10:00:05Z",
      action: "org.created",
    });
  });

  it("returns an empty query when nothing is filled in", () => {
    expect(utcQueryFromForm(toFormData({ from: "", result: "" }))).toBe("");
  });
});

describe("KNOWN_AUDIT_ACTIONS", () => {
  it("lists unique dotted actions within the API's 100 character limit", () => {
    expect(new Set(KNOWN_AUDIT_ACTIONS).size).toBe(KNOWN_AUDIT_ACTIONS.length);

    for (const action of KNOWN_AUDIT_ACTIONS) {
      expect(action).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(action.length).toBeLessThanOrEqual(100);
    }
  });
});
