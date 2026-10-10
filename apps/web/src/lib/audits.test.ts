import { describe, expect, it } from "vitest";
import { auditEventsQuery } from "./audits.ts";

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
