import { execFileSync } from "node:child_process";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { signUp } from "./helpers";

const SHOTS = "../../docs/features/SENTRA-3-roles-and-membership/screenshots";
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

async function createOrg(page: Page, name: string, slug: string) {
  await page.goto("/orgs/new");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Slug").fill(slug);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(`http://localhost:3000/orgs/${slug}`);
}

const signedInUserId = async (page: Page) => (await page.getByTestId("user-id").textContent())!;

const row = (page: Page, email: string) =>
  page.getByTestId("member-row").filter({ hasText: email });

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
  await admin.screenshot({ path: `${SHOTS}/1-admin-view.png` });

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
  await admin.screenshot({ path: `${SHOTS}/2-last-admin.png` });

  // Member view: names and roles only, no admin controls, and a Leave button for themself.
  await member.goto(`/orgs/${slug}/members`);
  await expect(member.getByTestId("member-row")).toHaveCount(2);
  await expect(member.getByRole("columnheader", { name: "Email" })).toHaveCount(0);
  await expect(member.locator("body")).not.toContainText(adminEmail);
  await expect(member.getByRole("button", { name: "Change role" })).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Leave" })).toHaveCount(1);
  await member.screenshot({ path: `${SHOTS}/3-member-view.png` });

  // The member leaves and is back on a home page with no organizations.
  await member.getByRole("button", { name: "Leave" }).click();
  await expect(member).toHaveURL("http://localhost:3000/");
  await expect(member.getByTestId("no-orgs")).toBeVisible();
  await admin.reload();
  await expect(admin.getByTestId("member-row")).toHaveCount(1);

  // Re-added, then removed by the admin: the member loses access immediately.
  seedMember(slug, memberId);
  await admin.reload();
  await row(admin, memberEmail).getByRole("button", { name: "Remove" }).click();
  await expect(admin.getByTestId("member-row")).toHaveCount(1);
  const gone = await member.goto(`/orgs/${slug}/members`);
  expect(gone?.status()).toBe(404);
  await member.screenshot({ path: `${SHOTS}/4-removed-member.png` });

  await memberContext.close();
});
