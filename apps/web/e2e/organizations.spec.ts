import { expect, test, type Browser, type Page } from "@playwright/test";
import { signUp } from "./helpers";

const SHOTS = "../../docs/features/SENTRA-2-create-organization/screenshots";

async function createOrg(page: Page, name: string, slug: string) {
  await page.getByRole("link", { name: "Create organization" }).click();
  await page.getByLabel("Name").fill(name);
  await expect(page.getByLabel("Slug")).toHaveValue(slug); // suggested from the name
  await page.screenshot({ path: `${SHOTS}/2-create-form.png` });
  await page.getByRole("button", { name: "Create organization" }).click();
}

async function expectOrgPage(page: Page, name: string, slug: string) {
  await expect(page).toHaveURL(`http://localhost:3000/orgs/${slug}`);
  await expect(page.getByTestId("org-name")).toHaveText(name);
  await expect(page.getByTestId("org-slug")).toHaveText(slug);
  await expect(page.getByTestId("org-role")).toHaveText("admin");
  await page.screenshot({ path: `${SHOTS}/3-org-page.png` });
}

async function expectSlugConflict(page: Page, slug: string) {
  await page.goto("/orgs/new");
  await page.getByLabel("Name").fill("Another");
  await page.getByLabel("Slug").fill(slug);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByTestId("form-error")).toContainText("already taken");
  await page.screenshot({ path: `${SHOTS}/4-slug-conflict.png` });
}

/** Another user gets the same not-found page as for an org that does not exist. */
async function expectInvisibleToOthers(browser: Browser, run: string, name: string, slug: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signUp(page, `org-intruder-${run}@example.com`);
  const response = await page.goto(`/orgs/${slug}`);
  expect(response?.status()).toBe(404);
  const forbidden = await page.locator("body").innerText();
  await page.screenshot({ path: `${SHOTS}/5-not-a-member.png` });
  const missing = await page.goto(`/orgs/nothing-${run}`);
  expect(missing?.status()).toBe(404);
  expect(await page.locator("body").innerText()).toBe(forbidden);
  expect(forbidden).not.toContain(name);
  await page.goto("/");
  await expect(page.getByTestId("no-orgs")).toBeVisible();
  await context.close();
}

async function expectSignInRedirect(browser: Browser, slug: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/orgs/${slug}`);
  await expect(page).toHaveURL(/localhost:8180\/ui\/v2\/login\/loginname/);
  await context.close();
}

test("create an organization, see it listed, and keep it invisible to other users", async ({
  page,
  browser,
}) => {
  const run = Date.now().toString(36);
  const [name, slug] = [`Acme ${run}`, `acme-${run}`];

  await signUp(page, `org-owner-${run}@example.com`);
  await expect(page.getByTestId("no-orgs")).toBeVisible(); // a new user belongs to no org
  await page.screenshot({ path: `${SHOTS}/1-empty-home.png` });

  await createOrg(page, name, slug);
  await expectOrgPage(page, name, slug);

  await page.goto("/");
  await expect(page.getByTestId("org-list").getByRole("link", { name })).toBeVisible();

  await expectSlugConflict(page, slug);
  await expectInvisibleToOthers(browser, run, name, slug);
  await expectSignInRedirect(browser, slug);
});
