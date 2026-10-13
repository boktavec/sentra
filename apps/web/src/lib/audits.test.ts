import { describe, expect, it } from "vitest";
import { actorLabel, auditEventsQuery, isRejectedFilters } from "./audits.ts";

describe("auditEventsQuery", () => {
  it("builds a next-page query with only the cursor when no filters are selected", () => {
    expect(auditEventsQuery({}, "next-page")).toBe("cursor=next-page");
  });

  it("preserves selected filters and omits empty filters on the next page", () => {
    const query = auditEventsQuery(
      {
        from: "2026-03-01T00:00:00Z",
        to: "",
        actorId: undefined,
        action: "project.created",
        result: "success",
      },
      "next-page",
    );

    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      from: "2026-03-01T00:00:00Z",
      action: "project.created",
      result: "success",
      cursor: "next-page",
    });
  });
});

describe("actorLabel", () => {
  const actor = "3f2b8c1e-9d4a-4b7e-8c21-5a6f0d3e1b94";

  it("is 'You' for the signed-in user and the short ID for anyone else", () => {
    expect(actorLabel(actor, actor)).toBe("You");
    expect(actorLabel(actor, "someone-else")).toBe("3f2b8c1e");
  });

  it("falls back to the short ID when /v1/me failed", () => {
    expect(actorLabel(actor, undefined)).toBe("3f2b8c1e");
  });
});

describe("isRejectedFilters", () => {
  it("treats only a 400 invalid_input as rejected filters", () => {
    expect(isRejectedFilters({ ok: false, status: 400, code: "invalid_input" })).toBe(true);
    expect(isRejectedFilters({ ok: false, status: 400, code: "other" })).toBe(false);
    expect(isRejectedFilters({ ok: false, status: 503 })).toBe(false);
    expect(isRejectedFilters({ ok: true, status: 200 })).toBe(false);
  });
});
