import { describe, expect, it } from "vitest";
import { parseTheme, themeClass } from "./theme";

describe("parseTheme", () => {
  it.each(["light", "dark", "system"] as const)("accepts %s", (theme) => {
    expect(parseTheme(theme)).toBe(theme);
  });

  it.each([undefined, "", "Dark", "auto", "dark foo", '"><script>'])(
    "falls back to system for %j",
    (value) => {
      expect(parseTheme(value)).toBe("system");
    },
  );
});

describe("themeClass", () => {
  it("forces light and dark, and leaves system to the OS", () => {
    expect(themeClass("light")).toBe("light");
    expect(themeClass("dark")).toBe("dark");
    expect(themeClass("system")).toBeUndefined();
  });
});
