import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import {
  createOrg,
  newSession,
  screenshotPath,
  seedMember,
  signUp,
  signedInUserId,
} from "./helpers";

const { Pool } = createRequire(new URL("../../api/package.json", import.meta.url))("pg");

const UNAVAILABLE_PORT = 3001;

const UNAVAILABLE_URL = `http://localhost:${UNAVAILABLE_PORT}`;

/** Creates an org and opens its audit history as the admin. */
async function openAuditHistory(page: Page, name: string) {
  const run = Date.now().toString(36);
  const slug = `${name}-${run}`;
  await signUp(page, `${name}-${run}@example.com`);
  await createOrg(page, `${name} ${run}`, slug);
  await page.getByRole("link", { name: "Audit history" }).click();
  await expect(page).toHaveURL(`http://localhost:3000/orgs/${slug}/audit-events`);

  return slug;
}

const stopServer = (server: ChildProcess) => process.kill(-server.pid!);

async function startWebWithoutApi() {
  const server = spawn("pnpm", ["exec", "next", "dev", "-p", String(UNAVAILABLE_PORT)], {
    env: {
      ...process.env,
      API_URL: "http://127.0.0.1:1",
      NEXT_DIST_DIR: "node_modules/.cache/next-audit-api-down",
    },
    stdio: "ignore",
    detached: true,
  });

  for (let i = 0; i < 60; i++) {
    if (
      await fetch(`${UNAVAILABLE_URL}/auth/login`, { redirect: "manual" }).then(
        () => true,
        () => false,
      )
    )
      return server;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  stopServer(server);
  throw new Error("The web app without an API did not start");
}

async function addPageOfAuditEvents(slug: string) {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) throw new Error("DATABASE_URL is required for the audit history browser test");
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const { rows } = await pool.query(
      `SELECT o.id AS org_id, o.created_by AS user_id FROM organizations o WHERE o.slug = $1`,
      [slug],
    );

    const org: { org_id: string; user_id: string } | undefined = rows[0];

    if (!org) throw new Error("Organization was not created");
    await pool.query(
      `INSERT INTO audit_events (org_id, actor_user_id, action, target_type, target_id)
       SELECT $1, $2, 'page.event', 'organization', $1 FROM generate_series(1, 51)`,
      [org.org_id, org.user_id],
    );
  } finally {
    await pool.end();
  }
}

test("an admin can filter organization audit history", async ({ page }) => {
  const run = Date.now().toString(36);
  const slug = `audit-${run}`;
  await signUp(page, `audit-admin-${run}@example.com`);
  await createOrg(page, `Audit ${run}`, slug);
  await page.getByRole("link", { name: "Audit history" }).click();
  await expect(page).toHaveURL(`http://localhost:3000/orgs/${slug}/audit-events`);
  await expect(page.getByTestId("audit-events")).toContainText("org.created");
  await expect(page.getByTestId("audit-events")).toContainText("You");
  await page.getByLabel("Result", { exact: true }).selectOption("success");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/result=success/);
  await expect(page.getByTestId("audit-events")).toContainText("org.created");
  await page.screenshot({ path: screenshotPath("SENTRA-20-audit-log", "1-filtered-history.png") });
});

test("an admin sees the empty state when no audit events match", async ({ page }) => {
  const run = Date.now().toString(36);
  const slug = `audit-empty-${run}`;
  await signUp(page, `audit-empty-${run}@example.com`);
  await createOrg(page, `Audit empty ${run}`, slug);
  await page.getByRole("link", { name: "Audit history" }).click();
  await page.getByLabel("Action", { exact: true }).fill("no.such.audit.action");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByTestId("no-audit-events")).toBeVisible();
});

test("an admin can open the next audit-history page", async ({ page }) => {
  const run = Date.now().toString(36);
  const slug = `audit-page-${run}`;
  await signUp(page, `audit-page-${run}@example.com`);
  await createOrg(page, `Audit page ${run}`, slug);
  await addPageOfAuditEvents(slug);
  await page.getByRole("link", { name: "Audit history" }).click();
  await page.getByRole("link", { name: "More audit events" }).click();
  await expect(page).toHaveURL(/cursor=/);
  await expect(page.locator("[data-testid=audit-events] tbody tr")).toHaveCount(2);
});

test("an admin sees the unavailable state when the API cannot be reached", async ({ page }) => {
  const run = Date.now().toString(36);
  const slug = `audit-unavailable-${run}`;
  await signUp(page, `audit-unavailable-${run}@example.com`);
  await createOrg(page, `Audit unavailable ${run}`, slug);
  const unavailable = await startWebWithoutApi();

  try {
    await page.goto(`${UNAVAILABLE_URL}/orgs/${slug}/audit-events`);
    await expect(page.getByTestId("api-unavailable")).toContainText("Reference:");
  } finally {
    stopServer(unavailable);
  }
});

test.describe("time zones and filter validation", () => {
  test.use({ timezoneId: "Europe/Amsterdam" });

  test("filters in local time send strict UTC and show local time with a UTC tooltip", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    const slug = await openAuditHistory(page, "audit-tz");
    await expect(page.getByText("Times in your time zone (Europe/Amsterdam)")).toBeVisible();

    const time = page.locator("[data-testid=audit-events] time").first();
    await expect(time).toHaveText(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (CEST|CET|GMT\+[12])$/);
    await expect(time).toHaveAttribute("title", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/);

    // Seconds are kept: without step=1 the browser flags a value like this as a step mismatch.
    await page.getByLabel("From", { exact: true }).fill("2026-01-15T10:00:05");
    await page.getByLabel("To", { exact: true }).fill("2099-01-01T00:00");
    await page.getByRole("button", { name: "Filter" }).click();
    await expect(page).toHaveURL(
      new RegExp(
        `/orgs/${slug}/audit-events\\?from=2026-01-15T09%3A00%3A05Z&to=2098-12-31T23%3A00%3A00Z`,
      ),
    );
    await expect(page.getByTestId("audit-events")).toContainText("org.created");
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("2026-01-15T10:00:05");
    await page.screenshot({ path: screenshotPath("SENTRA-36-ui-org-pages", "audit-filtered.png") });

    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(`http://localhost:3000/orgs/${slug}/audit-events`);
    await expect(page.getByRole("link", { name: "Clear filters" })).toHaveCount(0);
    expect(consoleErrors.filter((text) => /hydrat/i.test(text))).toEqual([]);
  });

  test("an invalid filter shows a validation alert, not an outage", async ({ page }) => {
    const slug = await openAuditHistory(page, "audit-invalid");
    await page.getByLabel("From", { exact: true }).fill("2026-03-02T10:00");
    await page.getByLabel("To", { exact: true }).fill("2026-03-01T10:00");
    await page.getByLabel("Actor ID").fill("not-a-uuid");
    await page.getByRole("button", { name: "Filter" }).click();

    const alert = page.getByTestId("audit-filter-error");
    await expect(alert).toContainText("From must be earlier than To.");
    await expect(alert).toContainText("Actor ID must be a UUID");
    await expect(page.getByLabel("To", { exact: true })).toBeFocused();
    await expect(page.getByTestId("api-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("audit-events")).toHaveCount(0);
    await expect(page.getByLabel("Actor ID")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Actor ID")).toHaveValue("not-a-uuid");
    await page.screenshot({ path: screenshotPath("SENTRA-36-ui-org-pages", "audit-invalid.png") });

    await page.setViewportSize({ width: 390, height: 800 });
    await page.screenshot({
      path: screenshotPath("SENTRA-36-ui-org-pages", "audit-invalid-m390.png"),
    });

    await page.goto(`/orgs/${slug}/audit-events?cursor=tampered`);
    await expect(page.getByTestId("audit-filter-error")).toContainText("rejected these filters");
    await expect(page.getByTestId("api-unavailable")).toHaveCount(0);
  });
});

test("without JavaScript a bare From and To are read as UTC", async ({ page, browser }) => {
  await openAuditHistory(page, "audit-nojs");

  const noJs = await browser.newContext({
    javaScriptEnabled: false,
    storageState: await page.context().storageState(),
  });

  const plain = await noJs.newPage();
  await plain.goto(page.url());
  await expect(plain.getByText("Times in UTC")).toBeVisible();
  await plain.getByLabel("From", { exact: true }).fill("2026-01-15T10:00");
  await plain.getByLabel("To", { exact: true }).fill("2099-01-01T00:00");
  await plain.getByRole("button", { name: "Filter" }).click();
  await expect(plain).toHaveURL(/from=2026-01-15T10%3A00&to=2099-01-01T00%3A00/);
  await expect(plain.getByTestId("audit-events")).toContainText("org.created");
  await expect(plain.locator("[data-testid=audit-events] time").first()).toContainText(" UTC");

  // From later than To is still caught on the server.
  await plain.getByLabel("From", { exact: true }).fill("2099-02-01T00:00");
  await plain.getByRole("button", { name: "Filter" }).click();
  await expect(plain.getByTestId("audit-filter-error")).toContainText("From must be earlier");
  await noJs.close();
});

test("a non-admin member cannot open audit history", async ({ browser, page }) => {
  const run = Date.now().toString(36);
  const slug = `audit-forbidden-${run}`;
  await signUp(page, `audit-forbidden-admin-${run}@example.com`);
  await createOrg(page, `Audit forbidden ${run}`, slug);
  const { context, page: member } = await newSession(browser, `audit-forbidden-${run}@example.com`);
  seedMember(slug, await signedInUserId(member));

  await member.goto(`/orgs/${slug}/audit-events`);
  await expect(member.getByText("You do not have access to audit history.")).toBeVisible();
  await expect(member.getByText("Only organization admins can view it.")).toBeVisible();
  await expect(member.getByTestId("audit-events")).toHaveCount(0);
  await context.close();
});
