import { expect, test } from "@playwright/test";
import { createOrg, signUp } from "./helpers";

const SHOTS = "../../docs/features/SENTRA-4-create-project/screenshots";

test("create projects, see them listed, and keep them invisible to non-members", async ({
  page,
  browser,
}) => {
  const run = Date.now().toString(36);
  const [orgName, orgSlug] = [`Acme ${run}`, `acme-${run}`];

  await signUp(page, `project-owner-${run}@example.com`);
  await createOrg(page, orgName, orgSlug);
  await expect(page.getByTestId("no-projects")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/1-empty-projects.png` });

  await page.getByLabel("Project name").fill("Web App");
  await expect(page.getByLabel("Project slug")).toHaveValue("web-app"); // suggested from the name
  await page.screenshot({ path: `${SHOTS}/2-create-form.png` });
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(`http://localhost:3000/orgs/${orgSlug}/projects/web-app`);
  await expect(page.getByTestId("project-name")).toHaveText("Web App");
  await page.screenshot({ path: `${SHOTS}/3-project-page.png` });

  // The same slug with a different name is a conflict; the same name with a new slug is fine.
  await page.goto(`/orgs/${orgSlug}`);
  await page.getByLabel("Project name").fill("Other");
  await page.getByLabel("Project slug").fill("web-app");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("project-form-error")).toContainText("already taken");
  await page.screenshot({ path: `${SHOTS}/4-slug-conflict.png` });
  await page.getByLabel("Project name").fill("Web App");
  await page.getByLabel("Project slug").fill("web-app-2");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(`http://localhost:3000/orgs/${orgSlug}/projects/web-app-2`);

  await page.goto(`/orgs/${orgSlug}`);
  const list = page.getByTestId("project-list");
  await expect(list.getByRole("link", { name: "Web App" })).toHaveCount(2);
  await page.screenshot({ path: `${SHOTS}/5-project-list.png` });

  // A non-member sees the same not-found page as for a project that does not exist.
  const context = await browser.newContext();
  const outsider = await context.newPage();
  await signUp(outsider, `project-intruder-${run}@example.com`);
  const denied = await outsider.goto(`/orgs/${orgSlug}/projects/web-app`);
  expect(denied?.status()).toBe(404);
  const body = await outsider.locator("body").innerText();
  await outsider.screenshot({ path: `${SHOTS}/6-not-a-member.png` });
  const missing = await outsider.goto(`/orgs/nothing-${run}/projects/web-app`);
  expect(missing?.status()).toBe(404);
  expect(await outsider.locator("body").innerText()).toBe(body);
  expect(body).not.toContain("Web App");
  await context.close();

  // Signed-out visitors go to sign-in.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/orgs/${orgSlug}/projects/web-app`);
  await expect(anonPage).toHaveURL(/localhost:8180\/ui\/v2\/login\/loginname/);
  await anon.close();
});
