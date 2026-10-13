import { execFileSync } from "node:child_process";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { createOrg, signUp, screenshotPath } from "./helpers";

const PG_CONTAINER = process.env["SENTRA_PG_CONTAINER"] ?? "sentra-sentra-postgres-1";

function psql(sql: string) {
  execFileSync("docker", ["exec", PG_CONTAINER, "psql", "-U", "sentra", "-d", "sentra", "-c", sql]);
}

/**
 * Zitadel access tokens carry no email or name today, so the API stores neither; give the user a
 * profile directly. Ids come from the app (a UUID), so interpolating them into SQL is safe here.
 */
const setProfile = (userId: string, email: string, name: string) =>
  psql(`UPDATE users SET email = '${email}', name = '${name}' WHERE id = '${userId}'`);

/** Invitations are a later story, so the second user is added to the org with SQL. */
const seedMember = (slug: string, userId: string) =>
  psql(`INSERT INTO memberships (org_id, user_id, role)
    SELECT id, '${userId}', 'member' FROM organizations WHERE slug = '${slug}'
    ON CONFLICT DO NOTHING`);

const signedInUserId = async (page: Page) => (await page.getByTestId("user-id").textContent())!;

const row = (page: Page, email: string) =>
  page.getByTestId("member-row").filter({ hasText: email });

const confirmDialog = (page: Page) => page.getByRole("alertdialog");

/** The row button and the dialog's confirm share a name, so the confirm is scoped to the dialog. */
async function confirm(page: Page, name: "Remove" | "Leave") {
  await confirmDialog(page).getByRole("button", { name, exact: true }).click();
}

async function newSession(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signUp(page, email);

  return { context, page };
}

test("admin manages members; a member sees less and can leave; the last admin is protected", async ({
  page: admin,
  browser,
}) => {
  const run = Date.now().toString(36);
  const slug = `team-${run}`;
  const [adminEmail, memberEmail] = [`mem-admin-${run}@example.com`, `mem-user-${run}@example.com`];

  await signUp(admin, adminEmail);
  setProfile(await signedInUserId(admin), adminEmail, "Ada Admin");
  await createOrg(admin, `Team ${run}`, slug);
  const { context: memberContext, page: member } = await newSession(browser, memberEmail);
  const memberId = await signedInUserId(member);
  setProfile(memberId, memberEmail, "Mel Member");
  seedMember(slug, memberId);

  // Admin view: emails, role controls, remove.
  await admin.getByRole("link", { name: "Members" }).click();
  await expect(admin).toHaveURL(`http://localhost:3000/orgs/${slug}/members`);
  await expect(admin.getByTestId("member-row")).toHaveCount(2);
  await expect(admin.getByRole("columnheader", { name: "Email" })).toBeVisible();
  await expect(row(admin, memberEmail).getByTestId("member-role")).toHaveText("member");
  await admin.screenshot({
    path: screenshotPath("SENTRA-3-roles-and-membership", "1-admin-view.png"),
  });

  // Promote, then demote.
  await row(admin, memberEmail).getByRole("combobox").selectOption("admin");
  await row(admin, memberEmail).getByRole("button", { name: "Change role" }).click();
  await expect(row(admin, memberEmail).getByTestId("member-role")).toHaveText("admin");
  await row(admin, memberEmail).getByRole("combobox").selectOption("member");
  await row(admin, memberEmail).getByRole("button", { name: "Change role" }).click();
  await expect(row(admin, memberEmail).getByTestId("member-role")).toHaveText("member");

  // The only admin cannot demote themself.
  await row(admin, adminEmail).getByRole("combobox").selectOption("member");
  await row(admin, adminEmail).getByRole("button", { name: "Change role" }).click();
  await expect(admin.getByTestId("members-error")).toContainText("at least one admin");
  await expect(row(admin, adminEmail).getByTestId("member-role")).toHaveText("admin");
  await admin.screenshot({
    path: screenshotPath("SENTRA-3-roles-and-membership", "2-last-admin.png"),
  });

  // Member view: names and roles only, no admin controls, and a Leave button for themself.
  await member.goto(`/orgs/${slug}/members`);
  await expect(member.getByTestId("member-row")).toHaveCount(2);
  await expect(member.getByRole("columnheader", { name: "Email" })).toHaveCount(0);
  await expect(member.locator("body")).not.toContainText(adminEmail);
  await expect(member.getByRole("button", { name: "Change role" })).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Leave" })).toHaveCount(1);
  await member.screenshot({
    path: screenshotPath("SENTRA-3-roles-and-membership", "3-member-view.png"),
  });

  // Cancelling Leave submits nothing and returns focus to the row button.
  await member.getByRole("button", { name: "Leave" }).click();
  await expect(confirmDialog(member)).toContainText(`Leave Team ${run}?`);
  await confirmDialog(member).getByRole("button", { name: "Cancel" }).click();
  await expect(confirmDialog(member)).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Leave" })).toBeFocused();
  await expect(member.getByTestId("member-row")).toHaveCount(2);

  // The member leaves and is back on a home page with no organizations.
  await member.getByRole("button", { name: "Leave" }).click();
  await confirm(member, "Leave");
  await expect(member).toHaveURL("http://localhost:3000/");
  await expect(member.getByTestId("no-orgs")).toBeVisible();
  await admin.reload();
  await expect(admin.getByTestId("member-row")).toHaveCount(1);

  // Re-added, then removed by the admin: the member loses access immediately.
  seedMember(slug, memberId);
  // Back to the bare URL: the failed demotion left `?error=` behind, and its banner would show.
  await admin.goto(`/orgs/${slug}/members`);
  await row(admin, memberEmail).getByRole("button", { name: "Remove" }).click();
  await expect(confirmDialog(admin)).toContainText("Mel Member");
  await confirmDialog(admin).evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished)),
  );
  await admin.screenshot({
    path: screenshotPath("SENTRA-36-ui-org-pages", "members-confirm-remove.png"),
  });
  await confirmDialog(admin).getByRole("button", { name: "Cancel" }).click();
  await expect(admin.getByTestId("member-row")).toHaveCount(2);
  await row(admin, memberEmail).getByRole("button", { name: "Remove" }).click();
  await confirm(admin, "Remove");
  await expect(admin.getByTestId("member-row")).toHaveCount(1);
  const gone = await member.goto(`/orgs/${slug}/members`);
  expect(gone?.status()).toBe(404);
  await member.screenshot({
    path: screenshotPath("SENTRA-3-roles-and-membership", "4-removed-member.png"),
  });

  await memberContext.close();
});

test("without JavaScript, Remove submits directly with no confirmation", async ({
  page: admin,
  browser,
}) => {
  const run = Date.now().toString(36);
  const slug = `nojs-${run}`;
  const [adminEmail, memberEmail] = [
    `nojs-admin-${run}@example.com`,
    `nojs-user-${run}@example.com`,
  ];

  await signUp(admin, adminEmail);
  await createOrg(admin, `NoJS ${run}`, slug);
  const { context: memberContext, page: member } = await newSession(browser, memberEmail);
  const memberId = await signedInUserId(member);
  setProfile(memberId, memberEmail, "Nora NoJs");
  seedMember(slug, memberId);
  await memberContext.close();

  // The same session, with JavaScript off: nothing hydrates, so the button is a plain submit.
  const noJs = await browser.newContext({
    javaScriptEnabled: false,
    storageState: await admin.context().storageState(),
  });

  const page = await noJs.newPage();
  await page.goto(`/orgs/${slug}/members`);
  await expect(page.getByTestId("member-row")).toHaveCount(2);
  await row(page, memberEmail).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("member-row")).toHaveCount(1);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await noJs.close();
});
