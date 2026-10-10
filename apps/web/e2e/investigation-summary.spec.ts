import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { createOrg, signUp } from "./helpers";

const SHOTS = "../../docs/features/SENTRA-19-evidence-based-summary/screenshots";
const { Pool } = createRequire(new URL("../../api/package.json", import.meta.url))("pg");

interface Seeded {
  findingId: string;
  relatedId: string;
}

/**
 * Findings come from the correlator and results from the worker plus the API, so this test seeds both with SQL:
 * a completed run holding a validated result, and an older completed run from before results existed.
 */
async function seed(orgSlug: string): Promise<Seeded> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the summary browser test");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows: scope } = await pool.query(
      `SELECT o.id AS org_id, p.id AS project_id, o.created_by AS user_id
       FROM organizations o JOIN projects p ON p.org_id = o.id WHERE o.slug = $1 AND p.slug = 'web-app'`,
      [orgSlug],
    );
    const { org_id: orgId, project_id: projectId, user_id: userId } = scope[0];
    const importId = (
      await pool.query(
        `INSERT INTO sbom_imports (org_id, project_id, created_by, filename, object_key, expires_at)
         VALUES ($1, $2, $3, 'summary.json', $4, now() + interval '1 day') RETURNING id`,
        [orgId, projectId, userId, `summary/${orgSlug}`],
      )
    ).rows[0].id;
    const advisoryId = (
      await pool.query(
        `INSERT INTO vulnerabilities (source, source_id, modified_at, source_artifact_sha256, source_entry,
           schema_version, adapter_version, summary, cvss_score, cvss_version)
         VALUES ('osv', $1, now(), $2, 'entry', 1, 1, 'Summary advisory', 9.8, '3.1') RETURNING id`,
        [`SUMMARY-${orgSlug}`, "c".repeat(64)],
      )
    ).rows[0].id;
    const finding = (purl: string, version: string) =>
      pool
        .query(
          `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope, import_id,
             match_quality, match_reason, matcher_version, evidence, status)
           VALUES ($1, $2, $3, $4, $5, 'PyPI', 'required', $6, 'confirmed', NULL, 1,
             '{"rule":"explicit_version"}', 'open') RETURNING id`,
          [orgId, projectId, advisoryId, purl, version, importId],
        )
        .then((r: { rows: { id: string }[] }) => r.rows[0]!.id);
    const findingId = await finding(`pkg:pypi/summary-${orgSlug}@1.0`, "1.0");
    const relatedId = await finding(`pkg:pypi/summary-${orgSlug}@2.0`, "2.0");

    const run = (promptVersion: number, draft: string | null) =>
      pool
        .query(
          `INSERT INTO investigations (org_id, project_id, finding_id, created_by, context_snapshot, model_id,
             prompt_version, status, draft, attempts, completed_at)
           VALUES ($1, $2, $3, $4, '{}', 'Qwen 3.8:27b', $5, 'completed', $6, 1, now()) RETURNING id`,
          [orgId, projectId, findingId, userId, promptVersion, draft],
        )
        .then((r: { rows: { id: string }[] }) => r.rows[0]!.id);
    await run(2, "legacy plain-text draft");
    const withResult = await run(3, null);

    const result = {
      summary: "The package has a remote code execution flaw in its parser.",
      tenantImpact: "Your web app parses untrusted files with the affected version.",
      nextSteps: ["Upgrade to a fixed version."],
      claims: [
        {
          text: "The affected version is in your SBOM.",
          evidence: ["call:1", "call:2"],
        },
        { text: "The advisory is known.", evidence: ["call:3"] },
      ],
      uncertainties: ["Whether the vulnerable parser is reachable is not known."],
      facts: {
        source: "get_finding_risk",
        findingId,
        purl: `pkg:pypi/summary-${orgSlug}@1.0`,
        version: "1.0",
        ecosystem: "PyPI",
        scope: "required",
        status: "open",
        matchQuality: "confirmed",
        advisory: {
          source: "osv",
          sourceId: `SUMMARY-${orgSlug}`,
          aliases: ["CVE-2099-1"],
          summary: "Summary advisory",
          cvssScore: 9.8,
          cvssVersion: "3.1",
        },
        kevStatus: "listed",
        priority: {
          tier: "P1",
          modelVersion: 1,
          baseReason: "kev_listed",
          scopeAdjusted: false,
          factors: {
            kev: "listed",
            cvss: { score: 9.8, category: "critical" },
            scope: "required",
            matchQuality: "confirmed",
          },
        },
      },
      evidence: [
        {
          ref: "call:1",
          tool: "get_finding_risk",
          kind: "finding",
          targets: [{ findingId, purl: `pkg:pypi/summary-${orgSlug}@1.0`, version: "1.0" }],
        },
        {
          ref: "call:2",
          tool: "list_related_findings",
          kind: "related_finding",
          targets: [
            { findingId: relatedId, purl: `pkg:pypi/summary-${orgSlug}@2.0`, version: "2.0" },
          ],
        },
        {
          ref: "call:3",
          tool: "lookup_advisory",
          kind: "advisory",
          advisoryId: `SUMMARY-${orgSlug}`,
        },
      ],
      gaps: ["occurrences_not_checked"],
      modelId: "Qwen 3.8:27b",
      promptVersion: 3,
      generatedAt: new Date().toISOString(),
    };
    await pool.query(
      `INSERT INTO investigation_results (investigation_id, org_id, project_id, attempt, schema_version, result)
       VALUES ($1, $2, $3, 1, 1, $4)`,
      [withResult, orgId, projectId, result],
    );
    return { findingId, relatedId };
  } finally {
    await pool.end();
  }
}

test("a member reads the validated summary of a completed run, with links to its evidence", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);
  const orgSlug = `summary-${run}`;
  mkdirSync(SHOTS, { recursive: true });

  await signUp(page, `summary-${run}@example.com`);
  await createOrg(page, `Summary ${run}`, orgSlug);
  await page.getByLabel("Project name").fill("Web App");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(`http://localhost:3000/orgs/${orgSlug}/projects/web-app`);
  const { relatedId } = await seed(orgSlug);

  await page.goto(`/orgs/${orgSlug}/projects/web-app/investigations`);
  await page
    .getByTestId("investigation-findings")
    .getByRole("button", { name: new RegExp(`summary-${orgSlug}@1.0`) })
    .click();

  // Newest first: the run with a result, then the run from before results existed.
  const viewButtons = page.getByRole("button", { name: "View summary" });
  await expect(viewButtons).toHaveCount(2);
  await viewButtons.nth(1).click();
  await expect(page.getByText("No structured summary for this run.")).toBeVisible();

  await viewButtons.nth(0).click();
  const facts = page.getByTestId("result-facts");
  await expect(facts).toContainText("From your project and security data");
  await expect(facts).toContainText("CVSS 9.8");
  await expect(facts).toContainText("In CISA KEV");
  await expect(page.getByTestId("result-priority")).toContainText("P1");
  const explanation = page.getByTestId("result-explanation");
  await expect(explanation).toContainText("AI-generated explanation");
  await expect(explanation).toContainText("remote code execution flaw");
  await expect(explanation).toContainText(`Advisory SUMMARY-${orgSlug}`);
  await expect(page.getByTestId("result-gaps")).toContainText(
    "Other versions of this dependency in the SBOM were not checked.",
  );
  await expect(page.getByTestId("result-gaps")).toContainText("is not known");
  await page.screenshot({ path: `${SHOTS}/1-summary.png`, fullPage: true });

  const link = page
    .getByTestId("result-claims")
    .getByRole("link", { name: `pkg:pypi/summary-${orgSlug}@2.0` });
  await expect(link).toHaveAttribute(
    "href",
    `/orgs/${orgSlug}/projects/web-app/findings/${relatedId}`,
  );
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/findings/${relatedId}$`));
  await expect(page.getByText(`summary-${orgSlug}@2.0`).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/2-evidence-link.png`, fullPage: true });
});
