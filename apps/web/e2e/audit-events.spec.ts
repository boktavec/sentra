import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { createOrg, signUp } from "./helpers";

const SHOTS = "../../docs/features/SENTRA-20-audit-log/screenshots";
const { Pool } = createRequire(new URL("../../api/package.json", import.meta.url))("pg");
const UNAVAILABLE_PORT = 3001;
const UNAVAILABLE_URL = `http://localhost:${UNAVAILABLE_PORT}`;

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
    const org = rows[0] as { org_id: string; user_id: string } | undefined;
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
  await page.getByLabel("Result").selectOption("success");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/result=success/);
  await expect(page.getByTestId("audit-events")).toContainText("org.created");
  await page.screenshot({ path: `${SHOTS}/1-filtered-history.png` });
});

test("an admin sees the empty state when no audit events match", async ({ page }) => {
  const run = Date.now().toString(36);
  const slug = `audit-empty-${run}`;
  await signUp(page, `audit-empty-${run}@example.com`);
  await createOrg(page, `Audit empty ${run}`, slug);
  await page.getByRole("link", { name: "Audit history" }).click();
  await page.getByLabel("Action").fill("no.such.audit.action");
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
