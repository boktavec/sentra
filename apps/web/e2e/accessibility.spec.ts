import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

test.describe("accessibility (WCAG 2 A/AA)", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`/dev/ui has no violations in ${theme} theme`, async ({ page, context }) => {
      // The proxy only checks that a session cookie exists; /dev/ui makes no API calls.
      await context.addCookies([
        { name: "sentra_session", value: "axe-fixture", url: "http://localhost:3000" },
        { name: "sentra-theme", value: theme, url: "http://localhost:3000" },
      ]);
      await page.goto("/dev/ui");
      await expect(page.getByRole("heading", { name: "UI reference" })).toBeVisible();
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));

      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
