import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { Redis } from "ioredis";

import { PASSWORD, register, verificationCode } from "./helpers";

const SHOTS = "../../docs/features/SENTRA-1-user-sign-in/screenshots";
const WEB = "http://localhost:3000";
const LOGIN_URL = /localhost:8180\/ui\/v2\/login\/loginname/;

const sessionCookie = async (context: BrowserContext) =>
  (await context.cookies(WEB)).find((c) => c.name === "sentra_session");

/** Registration does not sign the user in until the email is verified. */
async function registerUnverified(page: Page, context: BrowserContext, email: string) {
  await page.goto("/");
  await expect(page).toHaveURL(LOGIN_URL);
  await page.screenshot({ path: `${SHOTS}/1-sign-in.png` });

  await register(page, email);
  await expect(page).toHaveURL(/\/ui\/v2\/login\/verify/);
  await expect(page.getByText("Enter the Code provided in the verification email")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/2-verify-email.png` });
  // No Sentra session exists until verification completes.
  expect(await sessionCookie(context)).toBeUndefined();
}

/** Finishes verification; the web app then calls the API with the user's token. */
async function verifyAndReadUserId(page: Page, email: string): Promise<string> {
  await page.locator("input[name=code]").fill(await verificationCode(email));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(`${WEB}/`);
  const userId = await page.getByTestId("user-id").innerText();
  expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  await page.screenshot({ path: `${SHOTS}/3-signed-in.png` });
  return userId;
}

/** The browser holds only an opaque session cookie: no JWT is exposed to page scripts. */
async function expectOpaqueSessionCookie(page: Page, context: BrowserContext) {
  const session = (await sessionCookie(context))!;
  expect(session.httpOnly).toBe(true);
  expect(session.value).not.toContain(".");
  expect(await page.evaluate(() => document.cookie)).not.toContain("sentra_session");
  return session;
}

/** An expired access token is refreshed server-side, against the real identity provider. */
async function expectRefreshOnExpiry(page: Page, redis: Redis, key: string, userId: string) {
  const before = JSON.parse((await redis.get(key))!);
  await redis.set(key, JSON.stringify({ ...before, accessExpiresAt: 1 }), "KEEPTTL");
  await page.reload();
  await expect(page.getByTestId("user-id")).toHaveText(userId);
  const refreshed = JSON.parse((await redis.get(key))!);
  expect(refreshed.accessToken).not.toBe(before.accessToken);
  expect(refreshed.accessExpiresAt).toBeGreaterThan(Date.now() / 1000);
  return refreshed;
}

/**
 * A refresh token the provider rejects destroys that session. The provider session is still
 * alive, so single sign-on issues a brand-new web session for the same user.
 */
async function expectRejectedRefreshRenewsSession(
  page: Page,
  context: BrowserContext,
  redis: Redis,
  key: string,
  refreshed: object,
  userId: string,
  oldCookie: string,
) {
  const revoked = { ...refreshed, refreshToken: "revoked", accessExpiresAt: 1 };
  await redis.set(key, JSON.stringify(revoked), "KEEPTTL");
  await page.reload();
  await expect(page.getByTestId("user-id")).toHaveText(userId);
  expect(await redis.exists(key)).toBe(0);
  expect((await sessionCookie(context))!.value).not.toBe(oldCookie);
}

/** Sign out ends the web session and the identity-provider session. */
async function signOutAndBackIn(
  page: Page,
  context: BrowserContext,
  email: string,
  userId: string,
) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/localhost:(3000|8180)/);
  await page.goto("/");
  await expect(page).toHaveURL(LOGIN_URL);
  await page.screenshot({ path: `${SHOTS}/4-signed-out.png` });
  expect(await sessionCookie(context)).toBeUndefined();

  // Signing in again needs the password: the Zitadel session really ended.
  await page.locator("input[name=loginName]").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("input[name=password]")).toBeVisible();
  await page.locator("input[name=password]").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("user-id")).toHaveText(userId);
}

test("register, verify email, sign in, call the API, sign out", async ({ page, context }) => {
  const email = `e2e-${Date.now()}@example.com`;
  await registerUnverified(page, context, email);
  const userId = await verifyAndReadUserId(page, email);
  const session = await expectOpaqueSessionCookie(page, context);

  // Reloading keeps the same identity.
  await page.reload();
  await expect(page.getByTestId("user-id")).toHaveText(userId);

  const redis = new Redis(process.env["REDIS_URL"]!);
  const key = `session:${session.value}`;
  const refreshed = await expectRefreshOnExpiry(page, redis, key, userId);
  await expectRejectedRefreshRenewsSession(
    page,
    context,
    redis,
    key,
    refreshed,
    userId,
    session.value,
  );
  await redis.quit();

  await signOutAndBackIn(page, context, email, userId);
});

test("an API request without a valid token is rejected, and a forged session cookie gains nothing", async ({
  page,
  context,
  request,
}) => {
  const res = await request.get("http://localhost:4000/v1/me");
  expect(res.status()).toBe(401);
  expect((await res.json()).title).toBe("Authentication required");

  await context.addCookies([
    { name: "sentra_session", value: "forged", url: "http://localhost:3000" },
  ]);
  await page.goto("/");
  await expect(page).toHaveURL(/localhost:8180\/ui\/v2\/login\/loginname/);
});
