import { AppError } from "@sentra/ts-platform";
import { describe, expect, it } from "vitest";
import { validateNewSbom } from "./sbom-input.ts";

const MAX = 1000;

type Body = { filename?: string | number; size_bytes?: number | string } | null;

const reason = (body: Body) => {
  try {
    validateNewSbom(body, MAX);
  } catch (err) {
    if (err instanceof AppError) return err.reason;
    throw err;
  }
};

describe("validateNewSbom", () => {
  it("accepts a .json filename and a size within the cap, trimming the name", () => {
    expect(validateNewSbom({ filename: "  bom.JSON ", size_bytes: MAX }, MAX)).toEqual({
      filename: "bom.JSON",
      sizeBytes: MAX,
    });
  });

  it.each([
    [{ filename: "", size_bytes: 1 }, "filename"],
    [{ filename: "bom.xml", size_bytes: 1 }, "filename"],
    [{ filename: "a/b.json", size_bytes: 1 }, "filename"],
    [{ filename: "a\\b.json", size_bytes: 1 }, "filename"],
    [{ filename: "a\u0000.json", size_bytes: 1 }, "filename"],
    [{ filename: `${"a".repeat(251)}.json`, size_bytes: 1 }, "filename"],
    [{ filename: 5, size_bytes: 1 }, "filename"],
    [{ filename: "bom.json", size_bytes: 0 }, "size_bytes"],
    [{ filename: "bom.json", size_bytes: 1.5 }, "size_bytes"],
    [{ filename: "bom.json", size_bytes: "1" }, "size_bytes"],
    [{ filename: "bom.json", size_bytes: MAX + 1 }, "too_large"],
    [null, "filename"],
  ])("rejects %j as %s", (body, expected) => {
    expect(reason(body)).toBe(expected);
  });
});
