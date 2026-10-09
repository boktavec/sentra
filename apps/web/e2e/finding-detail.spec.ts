import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createOrg, signUp } from "./helpers";

const PRIORITY_SHOTS = "../../docs/features/SENTRA-14-risk-priority/screenshots";
const SHOTS = "../../docs/features/SENTRA-16-finding-detail/screenshots";
const { Pool } = createRequire(new URL("../../api/package.json", import.meta.url))("pg");

const HUGE_GROUP = 52;
const UNAVAILABLE_PORT = 3001;
const UNAVAILABLE_URL = `http://localhost:${UNAVAILABLE_PORT}`;

/** Stops the server and the `next` process it started (its process group). */
const stopServer = (server: ChildProcess) => process.kill(-server.pid!);

/** A second dev server (own build directory) whose API address refuses connections. */
async function startWebWithoutApi() {
  const server = spawn("pnpm", ["exec", "next", "dev", "-p", String(UNAVAILABLE_PORT)], {
    env: {
      ...process.env,
      API_URL: "http://127.0.0.1:1",
      NEXT_DIST_DIR: "node_modules/.cache/next-api-down",
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

/** Findings come from the correlator, so the browser test seeds them with SQL, one per scenario. */
async function seed(orgSlug: string, projectSlug: string) {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the finding detail browser test");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(
      `SELECT o.id AS org_id, p.id AS project_id, p.created_by
       FROM organizations o JOIN projects p ON p.org_id = o.id
       WHERE o.slug = $1 AND p.slug = $2`,
      [orgSlug, projectSlug],
    );
    const { org_id: orgId, project_id: projectId, created_by: userId } = rows[0];
    const importId = (
      await pool.query(
        `INSERT INTO sbom_imports (org_id, project_id, created_by, filename, status, object_key, expires_at)
         VALUES ($1, $2, $3, 'detail.json', 'parsed', $4, now()) RETURNING id`,
        [orgId, projectId, userId, `detail-${randomUUID()}`],
      )
    ).rows[0].id;
    const cve = `CVE-2026-${parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16)}`;

    const advisory = async (
      label: string,
      o: {
        aliases?: string[];
        score?: number;
        withdrawn?: boolean;
        details?: string;
        refs?: string;
      } = {},
    ) =>
      (
        await pool.query(
          `INSERT INTO vulnerabilities (source, source_id, aliases, summary, details, severity, cvss_score,
             cvss_version, cvss_calculated_at, withdrawn_at, refs, published_at, modified_at,
             source_artifact_sha256, source_entry, schema_version, adapter_version)
           VALUES ($1, $2, $3, $4, $5, '[]', $6, $7, now(), $8, $9::jsonb, '2026-01-02', '2026-02-03', $10, 'e', 1, 1)
           RETURNING id`,
          [
            label.startsWith("GHSA") ? "ghsa" : "osv",
            `${label}-${randomUUID()}`,
            o.aliases ?? [],
            `${label} summary`,
            o.details ?? null,
            o.score ?? null,
            o.score === undefined ? null : "3.1",
            o.withdrawn ? "2026-03-04" : null,
            o.refs ?? "[]",
            "a".repeat(64),
          ],
        )
      ).rows[0].id as string;
    const group = async (ids: string[]) => {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO vulnerability_groups (id, canonical_vulnerability_id) VALUES ($1, $2)",
        [id, ids[0]],
      );
      for (const v of ids)
        await pool.query(
          "INSERT INTO vulnerability_group_members (vulnerability_id, group_id) VALUES ($1, $2)",
          [v, id],
        );
    };
    const dependency = (purl: string, name: string, version: string) =>
      pool.query(
        `INSERT INTO sbom_dependencies (import_id, org_id, project_id, purl, purl_type, name, version, ecosystem, scope, occurrences)
         VALUES ($1, $2, $3, $4, 'pypi', $5, $6, 'PyPI', 'required', 1)`,
        [importId, orgId, projectId, purl, name, version],
      );
    const affected = async (vulnerabilityId: string, name: string, events: [string, string][]) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO vulnerability_affected (id, vulnerability_id, ecosystem, package_name)
         VALUES ($1, $2, 'PyPI', $3)`,
        [id, vulnerabilityId, name],
      );
      for (const [i, [type, version]] of events.entries())
        await pool.query(
          `INSERT INTO vulnerability_ranges (affected_id, range_index, event_index, range_type, event_type, event_version)
           VALUES ($1, 0, $2, 'ECOSYSTEM', $3, $4)`,
          [id, i, type, version],
        );
    };
    const finding = async (
      vulnerabilityId: string,
      purl: string,
      version: string,
      o: { unverifiable?: boolean; resolved?: boolean; evidence: object },
    ) =>
      (
        await pool.query(
          `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope, import_id,
             match_quality, match_reason, status, resolved_reason, resolved_at, matcher_version, evidence)
           VALUES ($1, $2, $3, $4, $5, 'PyPI', 'required', $6, $7, $8, $9, $10, $11, 1, $12) RETURNING id`,
          [
            orgId,
            projectId,
            vulnerabilityId,
            purl,
            version,
            importId,
            o.unverifiable ? "unverifiable" : "confirmed",
            o.unverifiable ? "version_unparseable" : null,
            o.resolved ? "resolved" : "open",
            o.resolved ? "dependency_removed" : null,
            o.resolved ? new Date() : null,
            JSON.stringify(o.evidence),
          ],
        )
      ).rows[0].id as string;
    const range = (pkg: string, dependencyVersion: string, events: object[]) => ({
      package: pkg,
      dependencyVersion,
      rule: "range",
      comparator: "pep440",
      range: { type: "ECOSYSTEM", events },
    });
    const events = [
      { type: "introduced", version: "0" },
      { type: "fixed", version: "1.2.0" },
    ];

    // Two advisories for one issue, the stronger one scored; the CVE is in KEV.
    const ghsa = await advisory("GHSA-trac", {
      aliases: [cve],
      details:
        "Remote code execution in the wiki renderer.\n\nAll versions before 1.2.0 are affected.",
      refs: JSON.stringify([
        { type: "ADVISORY", url: "https://example.test/advisory" },
        { type: "WEB", url: "javascript:alert(document.cookie)" },
        { type: "WEB", url: null },
      ]),
    });
    const osv = await advisory("PYSEC-trac", { aliases: [cve], score: 9.8 });
    await group([ghsa, osv]);
    await dependency("pkg:pypi/trac@1.0.0", "trac", "1.0.0");
    await affected(ghsa, "Trac", [
      ["introduced", "0"],
      ["fixed", "1.2.0"],
    ]);
    await affected(ghsa, "unrelated-package", [["introduced", "0"]]);
    const trac = await finding(ghsa, "pkg:pypi/trac@1.0.0", "1.0.0", {
      evidence: range("trac", "1.0.0", events),
    });
    await finding(osv, "pkg:pypi/trac@1.0.0", "1.0.0", {
      evidence: range("trac", "1.0.0", events),
    });
    await pool.query(
      `INSERT INTO normalization_runs (artifact_sha256, source, ecosystem, adapter_version, status, correlation_id)
       VALUES ($1, 'cisa-kev', 'none', 1, 'published', $2)`,
      [randomUUID().replaceAll("-", "").padEnd(64, "a"), `e2e-${orgSlug}`],
    );
    await pool.query(
      `INSERT INTO kev_entries (cve_id, vendor_project, product, name, required_action, known_ransomware_use,
         date_added, due_date, content_hash, catalog_version, date_released, source_artifact_sha256, adapter_version)
       VALUES ($1, 'Edgewall', 'Trac', 'Edgewall Trac RCE', 'Apply updates per vendor instructions.', 'Unknown',
         '2026-01-10', '2026-01-31', $2, 'e2e', now(), $2, 1)`,
      [cve, "b".repeat(64)],
    );

    const legacyAdvisory = await advisory("PYSEC-legacy", { score: 5.5 });
    await dependency("pkg:pypi/legacy@abc", "legacy", "abc");
    const unverifiable = await finding(legacyAdvisory, "pkg:pypi/legacy@abc", "abc", {
      unverifiable: true,
      evidence: range("legacy", "abc", events),
    });

    const withdrawn = await advisory("PYSEC-gone", { withdrawn: true });
    await dependency("pkg:pypi/gone@1.0", "gone", "1.0");
    const resolved = await finding(withdrawn, "pkg:pypi/gone@1.0", "1.0", {
      resolved: true,
      evidence: {
        package: "gone",
        dependencyVersion: "1.0",
        rule: "explicit_version",
        comparator: null,
      },
    });

    const huge: string[] = [];
    for (let i = 0; i < HUGE_GROUP; i++)
      huge.push(
        await advisory(`PYSEC-huge-${i}`, {
          details: "Long advisory text. ".repeat(100),
          refs: JSON.stringify(
            Array.from({ length: i === 0 ? 60 : 1 }, (_, n) => ({
              type: "WEB",
              url: `https://example.test/huge/${i}/${n}`,
            })),
          ),
        }),
      );
    await group(huge);
    await dependency("pkg:pypi/huge@1.0", "huge", "1.0");
    const hugeFindings: string[] = [];
    for (const id of huge)
      hugeFindings.push(
        await finding(id, "pkg:pypi/huge@1.0", "1.0", {
          evidence: {
            package: "huge",
            dependencyVersion: "1.0",
            rule: "explicit_version",
            comparator: null,
          },
        }),
      );
    const hugeId = hugeFindings[0]!;

    return { trac, unverifiable, resolved, hugeId, cve };
  } finally {
    await pool.end();
  }
}

test("members can read the evidence behind a finding, and outsiders cannot", async ({
  page,
  browser,
}) => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(PRIORITY_SHOTS, { recursive: true });
  const run = Date.now().toString(36);
  const orgSlug = `detail-${run}`;
  await signUp(page, `detail-owner-${run}@example.com`);
  await createOrg(page, `Detail ${run}`, orgSlug);
  await page.getByLabel("Project name").fill("Web App");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("link", { name: "View findings" })).toBeVisible();
  const ids = await seed(orgSlug, "web-app");
  const detail = (id: string) => `/orgs/${orgSlug}/projects/web-app/findings/${id}`;
  const shot = async (name: string, fullPage = true) => {
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
  };

  // From the list, through the card link, to a multi-advisory confirmed range match.
  await page.goto(`/orgs/${orgSlug}/projects/web-app/findings?status=all`);
  await page.getByRole("link", { name: ids.cve }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(ids.cve);
  await expect(page.getByTestId("priority")).toHaveText("Sentra priority P1 (model v1)");
  await expect(page.getByTestId("priority-reasons")).toContainText("Listed in CISA KEV: base P1");
  await expect(page.getByTestId("kev-status")).toContainText("In CISA KEV");
  await expect(page.getByTestId("kev-status")).toContainText(
    "Apply updates per vendor instructions.",
  );
  await expect(page.getByTestId("finding-member")).toHaveCount(2);
  await expect(page.getByText("Fixed in (per advisory range)")).toHaveCount(2);
  await expect(page.getByText("unrelated-package")).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.getByText("javascript:alert(document.cookie)")).toBeVisible();
  await expect(page.getByRole("link", { name: "https://example.test/advisory" })).toHaveAttribute(
    "rel",
    "noopener noreferrer nofollow",
  );
  await shot("1-confirmed-kev-group");

  await page.getByRole("link", { name: "Back to findings" }).click();
  await expect(page.getByTestId("findings-list")).toBeVisible();
  await page.goBack();
  await page.getByRole("link", { name: "Investigate findings" }).click();
  await expect(page.getByRole("heading", { name: "Investigations" })).toBeVisible();

  await page.goto(detail(ids.unverifiable));
  await expect(page.getByTestId("finding-member")).toContainText("cannot tell");
  await expect(page.getByTestId("finding-member")).not.toContainText("falls inside");
  await expect(page.getByTestId("priority-reasons")).toContainText(
    "Version could not be verified: tier unchanged",
  );
  await shot("2-unverifiable");
  await page.screenshot({ path: `${PRIORITY_SHOTS}/3-priority-breakdown.png` });

  await page.goto(detail(ids.resolved));
  await expect(page.getByTestId("finding-status")).toHaveText("Resolved");
  await expect(page.getByTestId("resolved-note")).toContainText("no longer in the project");
  await expect(page.getByTestId("withdrawn-note")).toContainText(
    "Withdrawn by source on 2026-03-04",
  );
  await shot("3-resolved-withdrawn");

  await page.goto(detail(ids.hugeId));
  await expect(page.getByTestId("members-truncated")).toBeVisible();
  await expect(page.getByTestId("refs-truncated")).toBeVisible();
  // Viewport only: the full page of a 50-advisory group is ~36,000 px (5 MB), over the repo's 500 KB file limit.
  await page.getByTestId("members-truncated").scrollIntoViewIfNeeded();
  await shot("4-truncated", false);

  const missing = await page.goto(detail(randomUUID()));
  expect(missing?.status()).toBe(404);
  await shot("5-not-found");

  // The same pages served by a web app whose API is unreachable (same cookies: ports do not isolate them).
  const unavailable = await startWebWithoutApi();
  try {
    await page.goto(`${UNAVAILABLE_URL}${detail(ids.trac)}`);
    await expect(page.locator("main[role=alert]")).toContainText("Reference:");
    await shot("6-error");
  } finally {
    stopServer(unavailable);
  }

  const context = await browser.newContext();
  const outsider = await context.newPage();
  await signUp(outsider, `detail-outsider-${run}@example.com`);
  const denied = await outsider.goto(detail(ids.trac));
  expect(denied?.status()).toBe(404);
  expect(await outsider.locator("body").innerText()).not.toContain("trac@1.0.0");
  await context.close();
});
