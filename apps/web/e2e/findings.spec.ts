import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createOrg, signUp } from "./helpers";

const SHOTS = "../../docs/features/SENTRA-15-findings-list/screenshots";
const PRIORITY_SHOTS = "../../docs/features/SENTRA-14-risk-priority/screenshots";
const { Pool } = createRequire(new URL("../../api/package.json", import.meta.url))("pg");

async function seed(orgSlug: string, projectSlug: string) {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the findings browser test");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(
      `SELECT o.id AS org_id, p.id AS project_id, p.created_by
       FROM organizations o JOIN projects p ON p.org_id = o.id
       WHERE o.slug = $1 AND p.slug = $2`,
      [orgSlug, projectSlug],
    );
    const { org_id: orgId, project_id: projectId, created_by: userId } = rows[0];
    const imported = await pool.query(
      `INSERT INTO sbom_imports (org_id, project_id, created_by, filename, status, object_key, expires_at)
       VALUES ($1, $2, $3, 'findings.json', 'parsed', $4, now()) RETURNING id`,
      [orgId, projectId, userId, `findings-${randomUUID()}`],
    );
    const importId = imported.rows[0].id;
    const cve = `CVE-2026-${parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16)}`;
    const advisory = async (label: string, score: number | null, aliases: string[]) => {
      const result = await pool.query(
        `INSERT INTO vulnerabilities (source, source_id, aliases, summary, severity, cvss_score,
           cvss_version, cvss_calculated_at, modified_at, source_artifact_sha256,
           source_entry, schema_version, adapter_version)
         VALUES ('osv', $1, $2, $3, '[]', $4, $5, now(), now(), $6, 'e', 1, 1) RETURNING id`,
        [
          `E2E-${label}-${randomUUID()}`,
          aliases,
          `${label} advisory`,
          score,
          score === null ? null : "3.1",
          "a".repeat(64),
        ],
      );
      return result.rows[0].id as string;
    };
    const high = await advisory("Critical", 9.8, [cve]);
    const unknown = await advisory("Unknown", null, []);
    const resolved = await advisory("Resolved", 3.1, []);
    for (const [id, purl, status] of [
      [high, "pkg:pypi/critical@1.0", "open"],
      [unknown, "pkg:pypi/unknown@1.0", "open"],
      [resolved, "pkg:pypi/resolved@1.0", "resolved"],
    ]) {
      await pool.query(
        `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem,
           scope, import_id, match_quality, status, resolved_reason, resolved_at, matcher_version, evidence)
         VALUES ($1, $2, $3, $4, '1.0', 'PyPI', 'required', $5, 'confirmed', $6,
           CASE WHEN $6 = 'resolved' THEN 'dependency_removed' ELSE NULL END,
           CASE WHEN $6 = 'resolved' THEN now() ELSE NULL END, 1, '{}'::jsonb)`,
        [orgId, projectId, id, purl, importId, status],
      );
    }
    await pool.query(
      `INSERT INTO normalization_runs (artifact_sha256, source, ecosystem, adapter_version, status, correlation_id)
       VALUES ($1, 'cisa-kev', 'none', 1, 'published', $2)`,
      [randomUUID().replaceAll("-", "").padEnd(64, "a"), `e2e-${orgSlug}`],
    );
    await pool.query(
      `INSERT INTO kev_entries (cve_id, date_added, content_hash, catalog_version,
         date_released, source_artifact_sha256, adapter_version)
       VALUES ($1, CURRENT_DATE, $2, 'e2e', now(), $2, 1)`,
      [cve, "b".repeat(64)],
    );
  } finally {
    await pool.end();
  }
}

test("members can review and filter findings without exposing them to outsiders", async ({
  page,
  browser,
}) => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(PRIORITY_SHOTS, { recursive: true });
  const run = Date.now().toString(36);
  const orgSlug = `findings-${run}`;
  await signUp(page, `findings-owner-${run}@example.com`);
  await createOrg(page, `Findings ${run}`, orgSlug);
  await page.getByLabel("Project name").fill("Web App");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("link", { name: "View findings" }).click();
  await expect(page.getByTestId("no-findings")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${SHOTS}/1-empty.png`, fullPage: true });

  await seed(orgSlug, "web-app");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId("finding-row")).toHaveCount(2);
  await expect(page.getByTestId("finding-row").first()).toContainText("Critical 9.8");
  await expect(page.getByTestId("priority-badge").first()).toHaveText("P1");
  await expect(page.getByTestId("priority-badge").last()).toHaveText("P3");
  await expect(page.getByTestId("finding-row").first()).toContainText("In CISA KEV");
  await expect(page.getByTestId("finding-row").last()).toContainText("Severity unavailable");
  await expect(page.getByTestId("finding-row").last()).toContainText(
    "Exploitation data unavailable",
  );
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("finding-row")).toHaveCount(2);
  await page.screenshot({ path: `${SHOTS}/2-open.png`, fullPage: true });
  await page.screenshot({ path: `${PRIORITY_SHOTS}/1-priority-list.png`, fullPage: true });

  await page.getByLabel("Priority").selectOption("p3");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByTestId("finding-row")).toHaveCount(1);
  await expect(page.getByTestId("finding-row")).toContainText("unknown@1.0");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("finding-row")).toHaveCount(1);
  await page.screenshot({ path: `${PRIORITY_SHOTS}/2-p3-filter.png`, fullPage: true });
  await page.getByLabel("Priority").selectOption("all");
  await page.getByLabel("Sort").selectOption("newest");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByTestId("finding-row")).toHaveCount(2);
  await page.getByLabel("Sort").selectOption("priority");

  await page.getByLabel("Severity").selectOption("critical");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByTestId("finding-row")).toHaveCount(1);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("finding-row")).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/3-critical-filter.png`, fullPage: true });

  await page.getByLabel("Status").selectOption("resolved");
  await page.getByLabel("Severity").selectOption("all");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByTestId("finding-row")).toHaveCount(1);
  await expect(page.getByTestId("finding-row")).toContainText("resolved@1.0");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("finding-row")).toContainText("resolved@1.0");
  await page.screenshot({ path: `${SHOTS}/4-resolved.png`, fullPage: true });

  await page.goto(`/orgs/${orgSlug}/projects/web-app/findings?cursor=invalid`);
  await expect(page.getByTestId("findings-error")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/6-error.png`, fullPage: true });

  const context = await browser.newContext();
  const outsider = await context.newPage();
  await signUp(outsider, `findings-outsider-${run}@example.com`);
  const denied = await outsider.goto(`/orgs/${orgSlug}/projects/web-app/findings`);
  expect(denied?.status()).toBe(404);
  expect(await outsider.locator("body").innerText()).not.toContain("critical@1.0");
  await outsider.screenshot({ path: `${SHOTS}/5-not-a-member.png`, fullPage: true });
  await context.close();
});
