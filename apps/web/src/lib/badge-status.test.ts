import { describe, expect, it } from "vitest";
import { findingStatusName, kevStatusName, runStatusName, severityLevel } from "./badge-status";

describe("severityLevel", () => {
  it.each(["critical", "high", "medium", "low", "info"])("keeps %s", (level) => {
    expect(severityLevel(level)).toBe(level);
  });

  it.each(["unavailable", "none", "", "Critical", "urgent"])("maps %j to info", (value) => {
    expect(severityLevel(value)).toBe("info");
  });
});

describe("status mapping", () => {
  it("passes finding status through", () => {
    expect(findingStatusName("open")).toBe("open");
    expect(findingStatusName("resolved")).toBe("resolved");
  });

  it("badges only listed KEV findings", () => {
    expect(kevStatusName("listed")).toBe("kev");
    expect(kevStatusName("not_listed")).toBeNull();
    expect(kevStatusName("unavailable")).toBeNull();
  });

  it("maps investigation completed to succeeded", () => {
    expect(runStatusName("completed")).toBe("succeeded");
    expect(runStatusName("queued")).toBe("queued");
    expect(runStatusName("running")).toBe("running");
    expect(runStatusName("failed")).toBe("failed");
  });
});
