import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatLocal, formatUtc, fromLocalInputValue, toLocalInputValue } from "./local-time.ts";

const originalTz = process.env["TZ"];

// `new Date` and the local getters read the process zone; Node re-reads TZ when it is assigned.
beforeAll(() => {
  process.env["TZ"] = "Europe/Amsterdam";
});

afterAll(() => {
  if (originalTz === undefined) delete process.env["TZ"];
  else process.env["TZ"] = originalTz;
});

describe("formatUtc", () => {
  it("shows the UTC wall clock with a UTC label, dropping milliseconds", () => {
    expect(formatUtc("2026-03-01T10:00:05.123Z")).toBe("2026-03-01 10:00:05 UTC");
  });
});

describe("formatLocal", () => {
  it("shows local wall clock time with a zone abbreviation, in winter and summer", () => {
    expect(formatLocal("2026-01-15T10:00:05Z", "Europe/Amsterdam")).toMatch(
      /^2026-01-15 11:00:05 (CET|GMT\+1)$/,
    );
    expect(formatLocal("2026-07-15T10:00:05Z", "Europe/Amsterdam")).toMatch(
      /^2026-07-15 12:00:05 (CEST|GMT\+2)$/,
    );
  });

  it("rolls the date over and uses 00 (not 24) at local midnight", () => {
    expect(formatLocal("2026-03-01T23:30:00Z", "Europe/Amsterdam")).toMatch(
      /^2026-03-02 00:30:00 /,
    );
  });

  it("uses the process zone when none is given", () => {
    expect(formatLocal("2026-07-15T10:00:05Z")).toMatch(/^2026-07-15 12:00:05 /);
  });
});

describe("toLocalInputValue", () => {
  it("converts a UTC instant to the local datetime-local value, with seconds", () => {
    expect(toLocalInputValue("2026-07-15T10:00:05Z")).toBe("2026-07-15T12:00:05");
  });
});

describe("fromLocalInputValue", () => {
  it("reads a datetime-local value as local time and returns strict UTC ISO", () => {
    expect(fromLocalInputValue("2026-07-15T12:00:05")).toBe("2026-07-15T10:00:05Z");
    expect(fromLocalInputValue("2026-01-15T11:00")).toBe("2026-01-15T10:00:00Z");
  });

  it("round-trips a UTC instant through the local input value", () => {
    const iso = "2026-03-01T10:00:05Z";

    expect(fromLocalInputValue(toLocalInputValue(iso))).toBe(iso);
  });

  it("returns undefined for empty or invalid values", () => {
    expect(fromLocalInputValue("")).toBeUndefined();
    expect(fromLocalInputValue("not a date")).toBeUndefined();
  });

  it("uses the offset before the spring-forward change and after it", () => {
    // Amsterdam jumps from 02:00 CET to 03:00 CEST on 2026-03-29 (01:00 UTC).
    expect(fromLocalInputValue("2026-03-29T01:59:59")).toBe("2026-03-29T00:59:59Z");
    expect(fromLocalInputValue("2026-03-29T03:00:00")).toBe("2026-03-29T01:00:00Z");
  });

  it("resolves a wall-clock time inside the spring-forward gap to a real instant", () => {
    // 02:30 does not exist on 2026-03-29; the browser moves it forward an hour.
    expect(fromLocalInputValue("2026-03-29T02:30:00")).toBe("2026-03-29T01:30:00Z");
  });

  it("resolves a repeated wall-clock time in the fall-back overlap to its first occurrence", () => {
    // Amsterdam repeats 02:00-03:00 on 2026-10-25 (CEST, then CET at 01:00 UTC).
    expect(fromLocalInputValue("2026-10-25T02:30:00")).toBe("2026-10-25T00:30:00Z");
  });
});
