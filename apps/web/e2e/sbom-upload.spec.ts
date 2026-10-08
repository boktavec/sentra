import { expect, test } from "@playwright/test";
import { createOrg, signUp } from "./helpers";

const SHOTS = "../../docs/features/SENTRA-5-upload-sbom/screenshots";
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

// Needs the whole stack: `task stack:up`, the API (migrated), the pipeline worker, and the
// storage bucket allowing browser POSTs from http://localhost:3000.
test("upload SBOMs, watch them validate or get rejected, and keep them private to the org", async ({
  page,
  browser,
}) => {
  const run = Date.now().toString(36);
  const [orgName, orgSlug] = [`Acme ${run}`, `acme-${run}`];

  await signUp(page, `sbom-owner-${run}@example.com`);
  await createOrg(page, orgName, orgSlug);
  await page.getByLabel("Project name").fill("Web App");
  await page.getByRole("button", { name: "Create project" }).click();
  const projectUrl = `http://localhost:3000/orgs/${orgSlug}/projects/web-app`;
  await expect(page).toHaveURL(projectUrl);
  await expect(page.getByTestId("no-sboms")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/1-empty-uploads.png` });

  // The browser refuses obviously wrong files without calling the API.
  const picker = page.getByTestId("sbom-file");
  await picker.setInputFiles({
    name: "bom.xml",
    mimeType: "text/xml",
    buffer: Buffer.from("<bom/>"),
  });
  await expect(page.getByTestId("sbom-error")).toContainText(".json");
  await picker.setInputFiles({
    name: "huge.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(11 * 1024 * 1024, "x"),
  });
  await expect(page.getByTestId("sbom-error")).toContainText("10 MiB");
  await expect(page.getByTestId("no-sboms")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/2-blocked-in-browser.png` });

  // A real CycloneDX file ends parsed, without a page reload.
  await picker.setInputFiles(`${FIXTURES}valid-bom.cdx.json`);
  const rows = page.getByTestId("sbom-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId("sbom-status")).toHaveText("Parsed", {
    timeout: 30_000,
  });
  await expect(rows.first()).toContainText("valid-bom.cdx.json");
  await expect(rows.first().getByTestId("sbom-dependencies")).toHaveText("2 dependencies");
  await page.screenshot({ path: `${SHOTS}/3-parsed.png` });

  // JSON that is not an SBOM is rejected with a reason a person can act on.
  await picker.setInputFiles(`${FIXTURES}not-cyclonedx.json`);
  await expect(rows).toHaveCount(2);
  const rejected = rows.filter({ hasText: "not-cyclonedx.json" });
  await expect(rejected.getByTestId("sbom-status")).toHaveText("Rejected", { timeout: 30_000 });
  await expect(rejected.getByTestId("sbom-reason")).toContainText("not a CycloneDX SBOM");
  await page.screenshot({ path: `${SHOTS}/4-rejected.png` });

  // Text that is not JSON at all.
  await picker.setInputFiles({
    name: "garbage.json",
    mimeType: "application/json",
    buffer: Buffer.from("this is not json"),
  });
  const garbage = rows.filter({ hasText: "garbage.json" });
  await expect(garbage.getByTestId("sbom-reason")).toContainText("not valid JSON", {
    timeout: 30_000,
  });

  // Uploads survive a reload.
  await page.reload();
  await expect(rows).toHaveCount(3);

  // A non-member sees the same not-found page as for a project that does not exist.
  const context = await browser.newContext();
  const outsider = await context.newPage();
  await signUp(outsider, `sbom-intruder-${run}@example.com`);
  const denied = await outsider.goto(projectUrl);
  expect(denied?.status()).toBe(404);
  expect(await outsider.locator("body").innerText()).not.toContain("valid-bom.cdx.json");
  await context.close();
});
