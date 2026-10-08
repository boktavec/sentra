import { describe, expect, it } from "vitest";
import {
  apiErrorMessage,
  checkFile,
  formatBytes,
  isActive,
  MAX_SBOM_BYTES,
  reasonMessage,
} from "./sbom-format.ts";

describe("checkFile", () => {
  it.each(["bom.json", "BOM.JSON", "my.app.cdx.json"])("accepts %s", (name) => {
    expect(checkFile(name, 1024)).toBeNull();
  });
  it("accepts a file of exactly the cap", () => {
    expect(checkFile("bom.json", MAX_SBOM_BYTES)).toBeNull();
  });
  it.each(["bom.xml", "bom", "bom.json.exe", "bom.txt"])("rejects the type of %s", (name) => {
    expect(checkFile(name, 10)).toMatch(/\.json/);
  });
  it("rejects empty and oversize files", () => {
    expect(checkFile("bom.json", 0)).toMatch(/empty/);
    expect(checkFile("bom.json", MAX_SBOM_BYTES + 1)).toMatch(/10 MiB/);
  });
});

describe("reasonMessage", () => {
  it.each(["size", "not_json", "not_cyclonedx", "unsupported_version", "processing_failed"])(
    "explains %s",
    (code) => {
      expect(reasonMessage(code).length).toBeGreaterThan(10);
    },
  );
  it("has a safe fallback and no text without a reason", () => {
    expect(reasonMessage("something_new")).toBe("The file was rejected.");
    expect(reasonMessage(null)).toBe("");
  });
});

describe("isActive", () => {
  it("is true only while the import is still moving", () => {
    expect(isActive("pending_upload")).toBe(true);
    expect(isActive("uploaded")).toBe(true);
    for (const done of ["validated", "rejected", "expired"] as const) {
      expect(isActive(done)).toBe(false);
    }
  });
});

describe("apiErrorMessage", () => {
  it("maps known refusals and leaves the rest to the caller", () => {
    expect(apiErrorMessage(429)).toMatch(/maximum/);
    expect(apiErrorMessage(409, "expired")).toMatch(/expired/);
    expect(apiErrorMessage(409, "upload_missing")).toMatch(/did not reach/);
    expect(apiErrorMessage(503)).toBeNull();
  });
});

describe("formatBytes", () => {
  it("picks a readable unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
    expect(formatBytes(null)).toBe("");
  });
});
