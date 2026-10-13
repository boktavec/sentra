import { expect, test } from "@playwright/test";
import {
  createOrg,
  signUp,
  startWebWithoutApi,
  stopServer,
  UNAVAILABLE_URL,
  screenshotPath,
} from "./helpers";

test("the shell shows navigation, switchers and breadcrumbs with names from the API", async ({
  page,
}) => {
  const run = Date.now().toString(36);
  const [orgName, orgSlug] = [`Shell Org ${run}`, `shell-${run}`];
  await signUp(page, `shell-${run}@example.com`);
  await createOrg(page, orgName, orgSlug);

  // Org level: sidebar, breadcrumbs, org switcher.
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Members" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Audit events" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(1);
  const crumbs = page.getByRole("navigation", { name: "breadcrumb" });
  await expect(crumbs.getByRole("link", { name: "Organizations" })).toBeVisible();
  await expect(crumbs.getByText(orgName)).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: screenshotPath("SENTRA-34-ui-foundation", "org-shell-light.png") });
  await page.getByRole("button", { name: "Switch organization" }).click();
  await expect(page.getByRole("menuitem", { name: orgName })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByRole("menuitem", { name: "All organizations" })).toHaveAttribute(
    "href",
    "/",
  );
  await page.keyboard.press("Escape");

  // Project level: the sidebar switches to project navigation.
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill("Web App");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("project-name")).toHaveText("Web App");
  const projectNav = page.getByRole("navigation", { name: "Primary" });
  await expect(projectNav.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(projectNav.getByRole("link", { name: "Findings" })).toBeVisible();
  await expect(projectNav.getByRole("link", { name: "Investigations" })).toBeVisible();
  await expect(projectNav.getByRole("link", { name: "Projects" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(1);
  await expect(crumbs.getByRole("link", { name: orgName })).toBeVisible();
  await expect(crumbs.getByText("Web App")).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Switch project" }).click();
  await expect(page.getByRole("menuitem", { name: "Web App" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByRole("menuitem", { name: "All projects" })).toHaveAttribute(
    "href",
    `/orgs/${orgSlug}`,
  );
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: screenshotPath("SENTRA-34-ui-foundation", "project-shell-light.png"),
  });

  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    path: screenshotPath("SENTRA-34-ui-foundation", "project-shell-dark.png"),
  });
  await page.goto(`/orgs/${orgSlug}`);
  await page.screenshot({ path: screenshotPath("SENTRA-34-ui-foundation", "org-shell-dark.png") });

  // Below md the sidebar is a sheet opened from the header.
  await page.setViewportSize({ width: 390, height: 800 });
  // Sign out is icon only at this width but keeps its name.
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Members" })).toBeVisible();
  await page.waitForTimeout(600); // let the slide-in finish before the screenshot
  await page.screenshot({
    path: screenshotPath("SENTRA-34-ui-foundation", "org-shell-mobile-sheet.png"),
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Toggle Sidebar" })).toBeFocused();

  // Following a link in the sheet closes it (the layout, and so the sheet state, persists).
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Members" }).click();
  await expect(page).toHaveURL(`http://localhost:3000/orgs/${orgSlug}/members`);
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("Sign out in the shell header ends the session", async ({ page }) => {
  const run = Date.now().toString(36);
  await signUp(page, `shell-signout-${run}@example.com`);
  await createOrg(page, `Sign Out ${run}`, `signout-${run}`);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto(`/orgs/signout-${run}`);
  await expect(page).toHaveURL(/localhost:8180\/ui\/v2\/login\/loginname/);
});

test("a collapsed sidebar is out of the tab order", async ({ page, context }) => {
  const run = Date.now().toString(36);
  await signUp(page, `shell-collapsed-${run}@example.com`);
  await createOrg(page, `Collapsed ${run}`, `collapsed-${run}`);
  await context.addCookies([
    { name: "sidebar_state", value: "false", url: "http://localhost:3000" },
  ]);
  await page.reload();
  await expect(page.locator('[data-slot="sidebar-container"]')).toHaveAttribute("inert", "");

  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");

    const insideNav = await page.evaluate(
      () => document.activeElement?.closest('[data-slot="sidebar-container"]') !== null,
    );

    expect(insideNav).toBe(false);
  }
});

test("the shell degrades to a minimal frame when the API is unavailable", async ({ page }) => {
  const run = Date.now().toString(36);
  const [orgName, orgSlug] = [`Shell Down ${run}`, `shell-down-${run}`];
  await signUp(page, `shell-down-${run}@example.com`);
  await createOrg(page, orgName, orgSlug);
  const unavailable = await startWebWithoutApi("node_modules/.cache/next-shell-api-down");

  try {
    for (const path of [`/orgs/${orgSlug}`, `/orgs/${orgSlug}/projects/web-app`]) {
      await page.goto(`${UNAVAILABLE_URL}${path}`);
      await expect(page.getByTestId("api-unavailable")).toContainText("Reference:");
      // Nothing the API did not return: no names, no org navigation.
      await expect(page.locator("body")).not.toContainText(orgName);
      await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(1);
      await expect(page.getByRole("navigation", { name: "breadcrumb" })).toContainText(
        "Organizations",
      );
      await page.getByRole("button", { name: "Switch organization" }).click();
      await expect(page.getByRole("menuitem")).toHaveText(["All organizations"]);
      await page.keyboard.press("Escape");
    }

    // The entry page degrades too: an error state with a reference, no Support ID, Sign out intact.
    await page.goto(`${UNAVAILABLE_URL}/`);
    await expect(page.getByTestId("api-unavailable")).toContainText("Reference:");
    await expect(page.getByTestId("user-id")).toHaveCount(0);
    await expect(page.getByTestId("org-list")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  } finally {
    stopServer(unavailable);
  }
});
