import { expect, test, type Page } from "@playwright/test";
import { createOrg, screenshotPath, signUp } from "./helpers";

const FEATURE = "SENTRA-35-ui-entry-onboarding";

async function setTheme(page: Page, theme: "light" | "dark") {
  await page
    .context()
    .addCookies([{ name: "sentra-theme", value: theme, url: "http://localhost:3000" }]);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(new RegExp(theme));
}

test("entry and onboarding pages: org picker, slug preview, invitation card", async ({ page }) => {
  const run = Date.now().toString(36);
  await signUp(page, `entry-${run}@example.com`);

  // First run: empty state, one Create organization link, Sign out in the header.
  await expect(page.getByTestId("no-orgs")).toContainText("You are not in any organization yet.");
  await expect(page.getByRole("link", { name: "Create organization" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(1);
  await expect(page.getByTestId("user-id")).toBeVisible();
  await page.screenshot({ path: screenshotPath(FEATURE, "home-empty-light.png") });
  await setTheme(page, "dark");
  await page.screenshot({ path: screenshotPath(FEATURE, "home-empty-dark.png") });
  await setTheme(page, "light");

  // Create form: the slug is suggested and previewed live.
  await page.getByRole("link", { name: "Create organization" }).click();
  await page.getByLabel("Name").fill("Entry Org");
  await expect(page.getByLabel("Slug")).toHaveValue("entry-org");
  await expect(page.getByTestId("slug-preview")).toHaveText("/orgs/entry-org");
  await page.getByLabel("Slug").fill(`entry-${run}`);
  await expect(page.getByTestId("slug-preview")).toHaveText(`/orgs/entry-${run}`);
  await page.screenshot({ path: screenshotPath(FEATURE, "new-org-light.png") });
  await setTheme(page, "dark");
  await page.screenshot({ path: screenshotPath(FEATURE, "new-org-dark.png") });
  await setTheme(page, "light"); // the reload clears the form
  await page.getByLabel("Name").fill("Entry Org");
  await page.getByLabel("Slug").fill(`entry-${run}`);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(`http://localhost:3000/orgs/entry-${run}`);

  // Org picker with organizations, including a long name that must truncate.
  await createOrg(page, `A very long organization name ${"x".repeat(40)}`, `long-${run}`);
  await page.goto("/");
  await expect(page.getByTestId("org-list").getByRole("link")).toHaveCount(2);
  await page.screenshot({ path: screenshotPath(FEATURE, "home-orgs-light.png") });
  await setTheme(page, "dark");
  await page.screenshot({ path: screenshotPath(FEATURE, "home-orgs-dark.png") });
  await setTheme(page, "light");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.screenshot({ path: screenshotPath(FEATURE, "home-orgs-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1280, height: 720 });

  // Invitation card (a fake token: the page makes no API call until Accept is pressed).
  await page.goto("/invitations/accept?token=screenshot-fixture");
  await expect(page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
  await page.screenshot({ path: screenshotPath(FEATURE, "accept-light.png") });
  await setTheme(page, "dark");
  await page.screenshot({ path: screenshotPath(FEATURE, "accept-dark.png") });
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByTestId("accept-error")).toContainText("not valid");
  await page.screenshot({ path: screenshotPath(FEATURE, "accept-error-dark.png") });
});
