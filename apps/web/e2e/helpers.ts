import { expect, type Page } from "@playwright/test";

const MAILPIT = "http://localhost:8025";
export const PASSWORD = "Sentra-Test-1234!";

/** Reads the verification code Zitadel emailed to Mailpit (polls: delivery is asynchronous). */
export async function verificationCode(email: string): Promise<string> {
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

export async function register(page: Page, email: string) {
  await page.getByRole("button", { name: "Register new user" }).click();
  await page.locator("input[name=firstname]").fill("Ada");
  await page.locator("input[name=lastname]").fill("Lovelace");
  await page.locator("input[name=email]").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("input[name=password]").fill(PASSWORD);
  await page.locator("input[name=confirmPassword]").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
}

/** Registers a new user, verifies their email, and lands on the signed-in home page. */
export async function signUp(page: Page, email: string) {
  await page.goto("/");
  await expect(page).toHaveURL(/localhost:8180\/ui\/v2\/login\/loginname/);
  await register(page, email);
  await page.locator("input[name=code]").fill(await verificationCode(email));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL("http://localhost:3000/");
}

/** Signs an existing user in from the identity provider's login page. */
export async function signIn(page: Page, email: string) {
  await page.locator("input[name=loginName]").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("input[name=password]").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
}

/** Creates an organization through the web form and waits for its page. */
export async function createOrg(page: Page, name: string, slug: string) {
  await page.goto("/orgs/new");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Slug").fill(slug);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(`http://localhost:3000/orgs/${slug}`);
}
