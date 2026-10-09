import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createOrg, signUp } from "./helpers";

const SHOTS = "../../docs/features/SENTRA-17-start-finding-investigation/screenshots";
const featureWebUrl = process.env["INVESTIGATION_WEB_URL"] ?? "http://localhost:3000";

/** Seed a real finding after the browser creates an authorized org and project. */
function seedFinding(orgSlug: string) {
  const sql = `WITH scope AS (
    SELECT o.id AS org_id, p.id AS project_id, o.created_by AS user_id
    FROM organizations o JOIN projects p ON p.org_id = o.id
    WHERE o.slug = '${orgSlug}' AND p.slug = 'web-app'
  ), import AS (
    INSERT INTO sbom_imports (org_id, project_id, created_by, filename, object_key, expires_at)
    SELECT org_id, project_id, user_id, 'browser.json', 'investigations/${orgSlug}', now() + interval '1 day'
    FROM scope RETURNING id, org_id, project_id
  ), advisory AS (
    INSERT INTO vulnerabilities (source, source_id, modified_at, source_artifact_sha256,
      source_entry, schema_version, adapter_version, summary)
    VALUES ('osv', 'BROWSER-${orgSlug}', now(), '${"b".repeat(64)}', 'entry', 1, 1,
      'Local test advisory for a vulnerable dependency') RETURNING id
  )
  INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope,
    import_id, match_quality, match_reason, matcher_version, evidence, status)
  SELECT i.org_id, i.project_id, a.id, 'pkg:pypi/browser-${orgSlug}@1.0', '1.0', 'PyPI',
    'required', i.id, 'unverifiable', 'no_version_data', 1, '{"rule":"no_version_data"}', 'open'
  FROM import i CROSS JOIN advisory a RETURNING id`;
  const output = execFileSync(
    "docker",
    ["exec", "sentra-sentra-postgres-1", "psql", "-U", "sentra", "-d", "sentra", "-Atc", sql],
    { encoding: "utf8" },
  );
  expect(output).toContain("INSERT 0 1");
}

test("start and observe a finding investigation through the browser", async ({ page }) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);
  const orgSlug = `investigate-${run}`;
  mkdirSync(SHOTS, { recursive: true });

  await signUp(page, `investigator-${run}@example.com`);
  await createOrg(page, `Investigations ${run}`, orgSlug);
  await page.getByLabel("Project name").fill("Web App");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(`http://localhost:3000/orgs/${orgSlug}/projects/web-app`);
  seedFinding(orgSlug);

  await page.goto(`${featureWebUrl}/orgs/${orgSlug}/projects/web-app`);
  await page.getByRole("link", { name: "Investigations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Investigations" })).toBeVisible();
  await expect(page.getByTestId("investigation-findings")).toContainText(`browser-${orgSlug}`);
  await page.screenshot({ path: `${SHOTS}/1-findings.png`, fullPage: true });

  await page.getByTestId("investigation-findings").getByRole("button").first().click();
  await expect(page.getByRole("button", { name: "Start investigation" })).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/2-selected-finding.png`, fullPage: true });
  await page.getByRole("button", { name: "Start investigation" }).click();
  await expect(page.getByTestId("investigation-runs")).toContainText(/queued|running|completed/);
  if (process.env["INVESTIGATION_EXPECT_MODEL"] === "1") {
    await expect(page.getByTestId("investigation-runs")).toContainText("completed", {
      timeout: 120_000,
    });
    await expect(page.getByTestId("investigation-runs")).toContainText("Draft saved");
    await page.screenshot({ path: `${SHOTS}/3-completed.png`, fullPage: true });
  }
});
