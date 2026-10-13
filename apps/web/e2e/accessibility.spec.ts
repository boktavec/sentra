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

  // Entry and onboarding pages. /orgs/new and the token-less accept page make no API calls on
  // render, so a placeholder session cookie is enough.
  for (const theme of ["light", "dark"] as const) {
    for (const [path, heading] of [
      ["/orgs/new", "Create organization"],
      ["/invitations/accept", "Join an organization"],
    ] as const) {
      test(`${path} has no violations in ${theme} theme`, async ({ page, context }) => {
        await context.addCookies([
          { name: "sentra_session", value: "axe-fixture", url: "http://localhost:3000" },
          { name: "sentra-theme", value: theme, url: "http://localhost:3000" },
        ]);
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
        await expect(page.locator("html")).toHaveClass(new RegExp(theme));
        await expectNoViolations(page);
      });
    }

    test(`/ (no organizations) has no violations in ${theme} theme`, async ({ page, context }) => {
      const run = Date.now().toString(36);
      await signUp(page, `axe-home-${theme}-${run}@example.com`);
      await context.addCookies([
        { name: "sentra-theme", value: theme, url: "http://localhost:3000" },
      ]);
      await page.reload();
      await expect(page.getByTestId("no-orgs")).toBeVisible();
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
      // One project, so the populated table is scanned rather than the empty state.
      await page.getByRole("button", { name: "New project" }).click();
      await page.getByLabel("Project name").fill("Web App");
      await page.getByRole("button", { name: "Create project" }).click();
      await expect(page.getByTestId("project-name")).toHaveText("Web App");
      await page.goto(`/orgs/axe-${theme}-${run}`);
      await context.addCookies([
        { name: "sentra-theme", value: theme, url: "http://localhost:3000" },
      ]);
      await page.reload();
      await expect(page.getByTestId("org-name")).toBeVisible();
      await expectNoViolations(page);

      // The New project dialog open, at a narrow width where Sign out is icon only.
      await page.setViewportSize({ width: 320, height: 700 });
      await page.getByRole("button", { name: "New project" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // axe reads colors mid fade-in as near-transparent text; wait for the animation to finish.
      await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      await expectNoViolations(page);
    });
  }
});
