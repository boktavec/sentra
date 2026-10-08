import { expect, test, type Browser, type Page } from "@playwright/test";
import { createOrg, invitationLink, signIn, signUp } from "./helpers";

const SHOTS = "../../docs/features/SENTRA-29-invitation-email-delivery/screenshots";
const LOGIN_URL = /localhost:8180\/ui\/v2\/login\/loginname/;

/** A new browser context, so each person has their own cookies and identity-provider session. */
async function newPerson(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function invite(admin: Page, email: string, role: "member" | "admin") {
  await admin.getByLabel("Email").fill(email);
  await admin.getByLabel("Invitation role").selectOption(role);
  await admin.getByRole("button", { name: "Invite" }).click();
  const link = await admin.getByTestId("invite-link").textContent();
  expect(link).toMatch(/\/invitations\/accept\?token=[A-Za-z0-9_-]{43}$/);
  return link!;
}

test("an admin invites someone, who signs in through the link and joins; wrong accounts and revoked links are refused", async ({
  page: admin,
  browser,
}) => {
  const run = Date.now().toString(36);
  const slug = `invite-${run}`;
  const [adminEmail, inviteeEmail, strangerEmail] = [
    `inv-admin-${run}@example.com`,
    `inv-invitee-${run}@example.com`,
    `inv-stranger-${run}@example.com`,
  ];

  // The invitee already has an account (and a verified email); their browser session is then dropped.
  const { context: signup, page: signupPage } = await newPerson(browser);
  await signUp(signupPage, inviteeEmail);
  await signup.close();

  await signUp(admin, adminEmail);
  await createOrg(admin, `Invite ${run}`, slug);
  await admin.goto(`/orgs/${slug}/members`);
  const shownLink = await invite(admin, inviteeEmail, "member");
  await expect(admin.getByTestId("invitation-row")).toHaveCount(1);
  // The invitee gets the link by email, and it is the same link the admin was shown.
  const link = await invitationLink(inviteeEmail);
  expect(link).toBe(shownLink);
  const mail = await admin.context().newPage();
  const found = await (
    await fetch(
      `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${inviteeEmail}`)}`,
    )
  ).json();
  await mail.goto(`http://localhost:8025/view/${found.messages[0].ID}`);
  await expect(mail.getByText(`Invite ${run}`).first()).toBeVisible();
  await mail.screenshot({ path: `${SHOTS}/email-received.png` });
  await mail.close();
  await admin.screenshot({ path: `${SHOTS}/1-invitation-created.png` });

  // A signed-in stranger cannot use the link, and learns nothing about the organization.
  const { context: strangerContext, page: stranger } = await newPerson(browser);
  await signUp(stranger, strangerEmail);
  await stranger.goto(link);
  await stranger.getByRole("button", { name: "Accept invitation" }).click();
  await expect(stranger.getByTestId("accept-error")).toContainText("different email address");
  await expect(stranger.locator("body")).not.toContainText(`Invite ${run}`);
  await stranger.screenshot({ path: `${SHOTS}/2-wrong-account.png` });
  await strangerContext.close();

  // The invitee is signed out: the link sends them to sign in, then back to the accept page.
  const { context: inviteeContext, page: invitee } = await newPerson(browser);
  await invitee.goto(link);
  await expect(invitee).toHaveURL(LOGIN_URL);
  await signIn(invitee, inviteeEmail);
  await expect(invitee).toHaveURL(link);
  await invitee.screenshot({ path: `${SHOTS}/3-accept-page.png` });
  await invitee.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitee).toHaveURL(`http://localhost:3000/orgs/${slug}`);
  await expect(invitee.getByTestId("org-role")).toHaveText("member");
  await invitee.screenshot({ path: `${SHOTS}/4-joined.png` });

  // The link is used up, and the admin sees the new member and no pending invitation.
  await invitee.goto(link);
  await invitee.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitee).toHaveURL(`http://localhost:3000/orgs/${slug}`); // same user: idempotent
  await inviteeContext.close();
  await admin.goto(`/orgs/${slug}/members`);
  await expect(admin.getByTestId("member-row")).toHaveCount(2);
  await expect(admin.getByTestId("invitations")).toHaveCount(0);

  // A revoked invitation cannot be used.
  const revokedLink = await invite(admin, `inv-later-${run}@example.com`, "admin");
  await admin.goto(`/orgs/${slug}/members`);
  await expect(admin.getByTestId("invitation-row")).toHaveCount(1);
  await admin.getByRole("button", { name: "Revoke" }).click();
  await expect(admin.getByTestId("invitation-row")).toHaveCount(0);
  const { context: lateContext, page: late } = await newPerson(browser);
  await signUp(late, `inv-later-${run}@example.com`);
  await late.goto(revokedLink);
  await late.getByRole("button", { name: "Accept invitation" }).click();
  await expect(late.getByTestId("accept-error")).toContainText("already used or was cancelled");
  await late.screenshot({ path: `${SHOTS}/5-revoked.png` });
  await lateContext.close();
});
