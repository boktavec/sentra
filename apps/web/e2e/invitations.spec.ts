import { expect, test, type Browser, type Page } from "@playwright/test";
import { createOrg, invitationLink, signIn, signUp, screenshotPath } from "./helpers";

const LOGIN_URL = /localhost:8180\/ui\/v2\/login\/loginname/;

/** A new browser context, so each person has their own cookies and identity-provider session. */
async function newPerson(browser: Browser) {
  const context = await browser.newContext();

  return { context, page: await context.newPage() };
}

/** Leaves the dialog open on its success state: the link is shown once and only Done closes it. */
async function invite(admin: Page, email: string, role: "member" | "admin") {
  await admin.getByRole("button", { name: "Invite member" }).click();
  await admin.getByLabel("Email", { exact: true }).fill(email);
  await admin.getByLabel("Invitation role", { exact: true }).selectOption(role);
  await admin.getByRole("button", { name: "Invite", exact: true }).click();
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
  await mail.screenshot({
    path: screenshotPath("SENTRA-29-invitation-email-delivery", "email-received.png"),
  });
  await mail.close();
  await admin.screenshot({
    path: screenshotPath("SENTRA-29-invitation-email-delivery", "1-invitation-created.png"),
  });

  // A signed-in stranger cannot use the link, and learns nothing about the organization.
  const { context: strangerContext, page: stranger } = await newPerson(browser);
  await signUp(stranger, strangerEmail);
  await stranger.goto(link);
  await stranger.getByRole("button", { name: "Accept invitation" }).click();
  await expect(stranger.getByTestId("accept-error")).toContainText("different email address");
  await expect(stranger.locator("body")).not.toContainText(`Invite ${run}`);
  await stranger.screenshot({
    path: screenshotPath("SENTRA-29-invitation-email-delivery", "2-wrong-account.png"),
  });
  await strangerContext.close();

  // The invitee is signed out: the link sends them to sign in, then back to the accept page.
  const { context: inviteeContext, page: invitee } = await newPerson(browser);
  await invitee.goto(link);
  await expect(invitee).toHaveURL(LOGIN_URL);
  await signIn(invitee, inviteeEmail);
  await expect(invitee).toHaveURL(link);
  await invitee.screenshot({
    path: screenshotPath("SENTRA-29-invitation-email-delivery", "3-accept-page.png"),
  });
  await invitee.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitee).toHaveURL(`http://localhost:3000/orgs/${slug}`);
  await expect(invitee.getByTestId("org-role")).toHaveText("member");
  await invitee.screenshot({
    path: screenshotPath("SENTRA-29-invitation-email-delivery", "4-joined.png"),
  });

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
  await expect(admin.getByRole("alertdialog")).toContainText("inv-later-");
  await admin.getByRole("alertdialog").getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(admin.getByTestId("invitation-row")).toHaveCount(0);
  const { context: lateContext, page: late } = await newPerson(browser);
  await signUp(late, `inv-later-${run}@example.com`);
  await late.goto(revokedLink);
  await late.getByRole("button", { name: "Accept invitation" }).click();
  await expect(late.getByTestId("accept-error")).toContainText("already used or was cancelled");
  await late.screenshot({
    path: screenshotPath("SENTRA-29-invitation-email-delivery", "5-revoked.png"),
  });
  await lateContext.close();
});

test("the invite link is locked in the dialog until Done, and can be copied", async ({
  page: admin,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const run = Date.now().toString(36);
  await signUp(admin, `inv-lock-${run}@example.com`);
  await createOrg(admin, `Lock ${run}`, `lock-${run}`);
  await admin.goto(`/orgs/lock-${run}/members`);
  const inviteeEmail = `inv-lock-invitee-${run}@example.com`;
  const link = await invite(admin, inviteeEmail, "member");
  const dialog = admin.getByRole("dialog");
  await expect(dialog).toContainText(`Invitation sent to ${inviteeEmail}`);
  await expect(dialog).toContainText("Shown only once");
  // The token is a live credential: mask it in the committed screenshots.
  const maskLink = [admin.getByTestId("invite-link")];

  await admin.screenshot({
    path: screenshotPath("SENTRA-36-ui-org-pages", "members-invite-link.png"),
    mask: maskLink,
  });

  // Esc, a click outside and the (absent) close button cannot dismiss the one-time link.
  await admin.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await admin.mouse.click(2, 2);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
  await expect(admin.getByTestId("invite-link")).toHaveText(link);

  await dialog.getByRole("button", { name: "Copy link" }).click();
  await expect(dialog.getByText("Copied")).toBeVisible();
  expect(await admin.evaluate(() => navigator.clipboard.readText())).toBe(link);

  // Done closes it, the pending list has refreshed behind it, and the link is gone from the page.
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(admin.getByRole("button", { name: "Invite member" })).toBeFocused();
  await expect(admin.getByTestId("invitation-row")).toHaveCount(1);
  await expect(admin.getByTestId("invitation-row")).toContainText(inviteeEmail);
  await expect(admin.getByTestId("invite-link")).toHaveCount(0);

  // Dark and narrow, for the PR screenshots (the theme is a cookie read on render).
  await context.addCookies([{ name: "sentra-theme", value: "dark", url: "http://localhost:3000" }]);
  await admin.setViewportSize({ width: 320, height: 700 });
  await admin.reload();
  await invite(admin, `inv-lock-dark-${run}@example.com`, "member");
  await admin.screenshot({
    path: screenshotPath("SENTRA-36-ui-org-pages", "members-invite-link-dark-m320.png"),
    mask: maskLink,
  });
});

test("a denied clipboard shows a failure status and leaves the link selectable", async ({
  page: admin,
  context,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });

  const run = Date.now().toString(36);
  await signUp(admin, `inv-deny-${run}@example.com`);
  await createOrg(admin, `Deny ${run}`, `deny-${run}`);
  await admin.goto(`/orgs/deny-${run}/members`);
  const link = await invite(admin, `inv-deny-invitee-${run}@example.com`, "member");
  const dialog = admin.getByRole("dialog");
  await dialog.getByRole("button", { name: "Copy link" }).click();
  await expect(dialog.getByText("Copy failed, select the link instead")).toBeVisible();
  await expect(admin.getByTestId("invite-link")).toHaveText(link);
});
