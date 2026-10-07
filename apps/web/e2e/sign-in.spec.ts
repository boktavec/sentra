import { expect, test, type Page } from "@playwright/test";
import { Redis } from "ioredis";

const MAILPIT = "http://localhost:8025";
const PASSWORD = "Sentra-Test-1234!";
const SHOTS = "../../docs/features/SENTRA-1-user-sign-in/screenshots";

/** Reads the verification code Zitadel emailed to Mailpit (polls: delivery is asynchronous). */
async function verificationCode(email: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const found = await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json();
    const id = found.messages?.[0]?.ID;
    if (id) {
      const message = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
      const code = /Code ([A-Z0-9]{6})/.exec(message.Text)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No verification email for ${email}`);
}

async function register(page: Page, email: string) {
  await page.getByRole("button", { name: "Register new user" }).click();
  await page.locator("input[name=firstname]").fill("Ada");
  await page.locator("input[name=lastname]").fill("Lovelace");
  await page.locator("input[name=email]").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("input[name=password]").fill(PASSWORD);
  await page.locator("input[name=confirmPassword]").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
}

test("register, verify email, sign in, call the API, sign out", async ({ page, context }) => {
  const email = `e2e-${Date.now()}@example.com`;

  // Unauthenticated visitors are sent to sign-in (the identity provider's login page).
  await page.goto("/");
  await expect(page).toHaveURL(/localhost:8180\/ui\/v2\/login\/loginname/);
  await page.screenshot({ path: `${SHOTS}/1-sign-in.png` });

  // Registration does not sign the user in until the email is verified.
  await register(page, email);
  await expect(page).toHaveURL(/\/ui\/v2\/login\/verify/);
  await expect(page.getByText("Enter the Code provided in the verification email")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/2-verify-email.png` });
  // No Sentra session exists until verification completes.
  expect(
    (await context.cookies("http://localhost:3000")).find((c) => c.name === "sentra_session"),
  ).toBeUndefined();

  // Finish verification with the code Zitadel emailed.
  await page.locator("input[name=code]").fill(await verificationCode(email));
  await page.getByRole("button", { name: "Continue" }).click();

  // Signed in: the web app called the API with the user's token and got a Sentra user ID back.
  await expect(page).toHaveURL("http://localhost:3000/");
  const userId = await page.getByTestId("user-id").innerText();
  expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  await page.screenshot({ path: `${SHOTS}/3-signed-in.png` });

  // The browser holds only an opaque session cookie: no JWT is exposed to page scripts.
  const cookies = await context.cookies("http://localhost:3000");
  const session = cookies.find((c) => c.name === "sentra_session")!;
  expect(session.httpOnly).toBe(true);
  expect(session.value).not.toContain(".");
  expect(await page.evaluate(() => document.cookie)).not.toContain("sentra_session");

  // Reloading keeps the same identity.
  await page.reload();
  await expect(page.getByTestId("user-id")).toHaveText(userId);

  // An expired access token is refreshed server-side, against the real identity provider.
  const redis = new Redis(process.env["REDIS_URL"]!);
  const key = `session:${session.value}`;
  const before = JSON.parse((await redis.get(key))!);
  await redis.set(key, JSON.stringify({ ...before, accessExpiresAt: 1 }), "KEEPTTL");
  await page.reload();
  await expect(page.getByTestId("user-id")).toHaveText(userId);
  const refreshed = JSON.parse((await redis.get(key))!);
  expect(refreshed.accessToken).not.toBe(before.accessToken);
  expect(refreshed.accessExpiresAt).toBeGreaterThan(Date.now() / 1000);

  // A refresh token the provider rejects destroys that session. The provider session is still
  // alive, so single sign-on issues a brand-new web session for the same user.
  await redis.set(
    key,
    JSON.stringify({ ...refreshed, refreshToken: "revoked", accessExpiresAt: 1 }),
    "KEEPTTL",
  );
  await page.reload();
  await expect(page.getByTestId("user-id")).toHaveText(userId);
  expect(await redis.exists(key)).toBe(0);
  const renewed = (await context.cookies("http://localhost:3000")).find(
    (c) => c.name === "sentra_session",
  )!;
  expect(renewed.value).not.toBe(session.value);
  await redis.quit();

  // Sign out ends the web session and the identity-provider session.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/localhost:(3000|8180)/);
  await page.goto("/");
  await expect(page).toHaveURL(/localhost:8180\/ui\/v2\/login\/loginname/);
  await page.screenshot({ path: `${SHOTS}/4-signed-out.png` });
  const afterLogout = (await context.cookies("http://localhost:3000")).find(
    (c) => c.name === "sentra_session",
  );
  expect(afterLogout).toBeUndefined();

  // Signing in again needs the password: the Zitadel session really ended.
  await page.locator("input[name=loginName]").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("input[name=password]")).toBeVisible();
  await page.locator("input[name=password]").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("user-id")).toHaveText(userId);
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
