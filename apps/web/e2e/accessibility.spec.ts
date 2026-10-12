import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createOrg, signUp } from "./helpers";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
}

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

      await expectNoViolations(page);
    });
  }

  // The org page runs inside the shell (sidebar, header, breadcrumbs). "system" has no class on
  // <html>, so the color scheme comes from the emulated OS preference.
  for (const [theme, scheme] of [
    ["light", "light"],
    ["dark", "dark"],
    ["system", "dark"],
  ] as const) {
    test(`the org page shell has no violations in ${theme} theme (OS ${scheme})`, async ({
      page,
      context,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const run = Date.now().toString(36);
      await signUp(page, `axe-${theme}-${run}@example.com`);
      await createOrg(page, `Axe ${run}`, `axe-${theme}-${run}`);
      await context.addCookies([
        { name: "sentra-theme", value: theme, url: "http://localhost:3000" },
      ]);
      await page.reload();
      await expect(page.getByTestId("org-name")).toBeVisible();
      await expectNoViolations(page);
    });
  }
});
