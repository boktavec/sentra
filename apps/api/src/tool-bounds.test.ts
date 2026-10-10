import { describe, expect, it } from "vitest";
import { Bounds, fitItems, fitOptional, jsonBytes, MAX_RESULT_BYTES } from "./tool-bounds.ts";

describe("Bounds", () => {
  it("cuts text to the byte budget without splitting a character, and remembers it", () => {
    const bounds = new Bounds();
    const cut = bounds.text("é".repeat(1000))!;
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(1024);
    expect(cut).toMatch(/^é+$/);
    expect(bounds.truncated).toBe(true);
  });

  it("measures the budget as JSON-escaped size, so control characters and quotes cannot overflow it", () => {
    const bounds = new Bounds();
    for (const text of [
      "\u0001".repeat(1024),
      '"'.repeat(1024),
      "\\".repeat(1024),
      "\n".repeat(1024),
    ]) {
      const cut = bounds.text(text)!;
      expect(jsonBytes(cut) - 2).toBeLessThanOrEqual(1024);
      expect(cut.length).toBeGreaterThan(0);
    }
    expect(bounds.truncated).toBe(true);
  });

  it("leaves short text and null alone", () => {
    const bounds = new Bounds();
    expect(bounds.text("fine")).toBe("fine");
    expect(bounds.text(null)).toBeNull();
    expect(bounds.truncated).toBe(false);
  });

  it("keeps ten aliases of at most 128 bytes", () => {
    const bounds = new Bounds();
    const aliases = bounds.aliases(Array.from({ length: 11 }, () => "a".repeat(200)));
    expect(aliases).toHaveLength(10);
    expect(aliases.every((a) => a.length === 128)).toBe(true);
    expect(bounds.truncated).toBe(true);
  });

  it("drops evidence over 2 KiB entirely rather than returning a broken fragment", () => {
    const bounds = new Bounds();
    expect(bounds.evidence({ rule: "x" })).toEqual({ rule: "x" });
    expect(bounds.truncated).toBe(false);
    expect(bounds.evidence({ blob: "z".repeat(3000) })).toBeNull();
    expect(bounds.truncated).toBe(true);
  });
});

describe("fitItems", () => {
  const build = (kept: string[]) => ({ items: kept });

  it("keeps everything that fits", () => {
    const bounds = new Bounds();
    expect(fitItems(["a", "b"], build, bounds)).toEqual(["a", "b"]);
    expect(bounds.truncated).toBe(false);
  });

  it("drops items from the end until the result fits, and flags it", () => {
    const bounds = new Bounds();
    const items = Array.from({ length: 10 }, () => "x".repeat(2000));
    const kept = fitItems(items, build, bounds);
    expect(kept).toHaveLength(4);
    expect(jsonBytes(build(kept))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(bounds.truncated).toBe(true);
  });

  it("fails clearly when even an empty list does not fit", () => {
    expect(() => fitItems([], () => ({ big: "x".repeat(MAX_RESULT_BYTES) }), new Bounds())).toThrow(
      /size cap/,
    );
  });
});

describe("fitOptional", () => {
  it("drops the optional bulk when the full result is too big, and flags it", () => {
    const bounds = new Bounds();
    const built = fitOptional(
      (full) => ({ core: "x", bulk: full ? "y".repeat(MAX_RESULT_BYTES) : null }),
      bounds,
    );
    expect(built.bulk).toBeNull();
    expect(bounds.truncated).toBe(true);
  });

  it("fails clearly when the reduced result still does not fit", () => {
    expect(() => fitOptional(() => ({ core: "x".repeat(MAX_RESULT_BYTES) }), new Bounds())).toThrow(
      /size cap/,
    );
  });
});
