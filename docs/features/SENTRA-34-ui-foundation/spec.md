# SENTRA-34: UI foundation (tokens, theme, app shell, shared primitives)

- Status: PR1 implemented (foundation); PR2 (shell) pending
- YouTrack: [SENTRA-34](http://localhost:8080/issue/SENTRA-34)
- Owner: apps/web
- Dependent stories: SENTRA-35 (entry/onboarding), SENTRA-36 (org pages), SENTRA-37 (project overview), SENTRA-38 (findings/investigations pages)

## Problem and outcome

`apps/web` currently renders every page in a 640px column with inline `style={{...}}` and no design system: no Tailwind, no `components.json`, no shared components, no layouts under `/orgs/[slug]`. Each page fetches its own org/project and renders ad-hoc `<p data-testid=...>` states. The planned UI revamp (SENTRA-35..38) needs a common visual language and frame to build on.

Done means:

- A token-based design system (light and dark, AA-compliant) on Tailwind v4 + shadcn/ui exists in `apps/web`, with documented semantic tokens including a severity/status scale.
- Shared primitives (page header, data table, filter bar, empty/error/loading states, severity/status badges, theme toggle) exist and are demonstrated on a `/dev/ui` reference page.
- All org and project routes render inside a new app shell (sidebar, org/project switcher, breadcrumbs); existing page bodies still work and all existing e2e tests pass.
- Automated axe checks guard WCAG 2 A/AA in both themes.

## Scope

- In scope:
  - Tailwind CSS v4 + shadcn/ui setup in `apps/web` (`components.json`, `src/components/ui`, `src/lib/utils.ts` `cn` helper).
  - Design tokens: shadcn semantic color set, severity and status tokens, density/typography/radius, both themes.
  - Theme: light/dark/system, default system, manual toggle, cookie persistence, no flash.
  - Shared primitives (listed in Architecture).
  - `/dev/ui` reference page (404 in production).
  - App shell: sidebar (org-level and project-level navigation), org/project switcher, breadcrumbs; minimal centered layout for non-org routes.
  - Wiring the shell into existing routes via new `layout.tsx` files; base styles applied to existing page bodies.
  - `@axe-core/playwright` accessibility spec in both themes.
- Out of scope:
  - Rebuilding page bodies with the new primitives (SENTRA-35..38).
  - Charts / severity summaries (SENTRA-37).
  - Switcher search, command palette, keyboard shortcuts beyond component defaults.
  - Client-side table state (sorting, column visibility, row selection); TanStack Table is a recorded future option.
  - Brand/logo refresh, marketing pages.
  - Any API or data model change.
- Dependencies and related stories: none upstream. SENTRA-35..38 depend on this story. Delivered as two stacked PRs (PR2 branched from PR1).

## Decisions and alternatives

| Decision                        | Chosen approach                                                                                                                                                                                                                                                                                                                                                       | Alternatives considered                                                         | Reason and tradeoff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visual direction                | Linear-style dense and calm base, with security-console strength for severity/status color                                                                                                                                                                                                                                                                            | Vercel/Geist minimal; full security-console (dark-first, saturated)             | Core screens are scanned/triaged tables, so density pays off; strong severity color is where the signal is. Risk: color overload, mitigated by the placement rules below.                                                                                                                                                                                                                                                                                                                                                                |
| Severity/status color placement | Solid saturated badges (always with text label); left-border accent on critical and high rows and on the finding detail header; neutral chrome elsewhere                                                                                                                                                                                                              | Badges only; console-saturated rows/backgrounds/charts                          | Strong where it matters, calm elsewhere; color is never the only signal (color-blind safe).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Theme strategy                  | Full light/dark parity; default follows OS; manual light/dark/system toggle; cookie-persisted                                                                                                                                                                                                                                                                         | Dark-first; light-first                                                         | Neither theme second-class for SENTRA-35..38. Cost: two tuned severity palettes, both themes AA-checked and screenshotted.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Theme mechanism                 | Cookie `sentra-theme` = `light` / `dark` / `system`; root layout reads it server-side and sets `class="light"` or `class="dark"` on `<html>` (no class for `system`); CSS applies dark tokens via `.dark` and via `@media (prefers-color-scheme: dark) { :root:not(.light) { ... } }`. Toggle is a small client component that writes the cookie and swaps the class. | `next-themes` (localStorage + inline script); inline head script reading cookie | No new dependency, no inline script, no flash for explicit choices and for system (pure CSS). Tradeoff: tokens for dark must be declared in two selectors (one shared block via CSS nesting or duplication). **Assumed:** this renders without flash in Next 16 + Tailwind v4; Tailwind docs (context7, `/tailwindlabs/tailwindcss.com`) confirm class-based dark via `@custom-variant` and that the preference may be stored/rendered server-side. Validated in PR1 by manual reload in all three modes and by axe runs in both themes. |
| `dark:` variant                 | Define `@custom-variant dark` to match `.dark` and system-dark-without-`.light`; components should prefer semantic tokens and use `dark:` rarely                                                                                                                                                                                                                      | Tailwind default media-only `dark:`                                             | Keeps `dark:` consistent with the toggle. **Assumed** syntax (nested `@media` inside `@custom-variant`) works in the installed Tailwind v4; verify in PR1 via context7 and the `/dev/ui` page.                                                                                                                                                                                                                                                                                                                                           |
| Component library               | shadcn/ui (copy-in components, Radix primitives) on Tailwind v4                                                                                                                                                                                                                                                                                                       | Hand-rolled CSS modules; other kits                                             | Story mandates shadcn; `shadcn` CLI is already a root devDependency. Adds Tailwind + Radix runtime deps.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PR shape                        | Two stacked PRs: PR1 foundation + `/dev/ui`; PR2 shell + layouts                                                                                                                                                                                                                                                                                                      | One PR; foundation-only with no route wiring; migrate all pages now             | Reviewable sizes; shell proven on real routes and existing e2e without absorbing SENTRA-35..38.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Switcher data                   | Server-rendered in org/project layouts: first page (limit ~20) of orgs and projects, then "All organizations" / "All projects" links to existing paginated pages; React `cache()` on `fetchOrg`/`fetchProject` so layout and page share one call per request                                                                                                          | Lazy client fetch via new BFF route handler; links only                         | Reuses existing server API helpers and session; no new endpoint or token-forwarding surface. Layouts persist across client navigation, so the cost is paid on entering an org/project, not every click.                                                                                                                                                                                                                                                                                                                                  |
| Data table                      | Plain composition on shadcn `Table`; server-component friendly; cursor "Load more" via `href`; sorting/filtering stay as URL search params via a `FilterBar` around existing GET forms                                                                                                                                                                                | shadcn data-table on TanStack Table; A with TanStack-shaped column API          | Matches the current server/URL model, no client JS for tables, existing flows unchanged. TanStack recorded as future option (e.g. bulk triage selection).                                                                                                                                                                                                                                                                                                                                                                                |
| Accessibility verification      | `@axe-core/playwright` (dev dependency) spec on `/dev/ui` and one shell route, light and dark, failing on WCAG 2 A/AA violations                                                                                                                                                                                                                                      | Token contrast unit test; both; manual only                                     | Checks the real rendered DOM and protects later stories.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Fonts                           | Geist Sans + Geist Mono via `next/font` (mono for IDs, slugs, CVE IDs)                                                                                                                                                                                                                                                                                                | Inter; system-ui                                                                | Fits the dense, technical look; self-hosted by `next/font` at build. **Assumed** available via `next/font/google` in Next 16; verify in PR1 (fallback: `geist` npm package).                                                                                                                                                                                                                                                                                                                                                             |
| Icons                           | `lucide-react`                                                                                                                                                                                                                                                                                                                                                        | Other icon sets                                                                 | shadcn default; no extra decision cost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Reference page route            | `/dev/ui`, `notFound()` when `NODE_ENV === "production"`                                                                                                                                                                                                                                                                                                              | `/_dev/ui`                                                                      | Folders prefixed with `_` are private in the App Router and not routable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

ADR: not required. The choices are local to `apps/web` and reversible; this spec records them. If a later story adds client table state or a second front-end, revisit.

## Architecture and contracts

- Affected components and ownership: `apps/web` only. No API, event, or storage changes.
- New files (indicative):
  - `apps/web/components.json`, `apps/web/postcss.config.mjs`, `apps/web/src/app/globals.css` (Tailwind import, tokens for both themes, `@custom-variant dark`, base styles).
  - `apps/web/src/lib/utils.ts` (`cn`), `apps/web/src/lib/theme.ts` (cookie name, parse/validate value, server helper).
  - `apps/web/src/components/ui/*` (shadcn stock: button, badge, table, dropdown-menu, sheet, skeleton, separator, breadcrumb, sidebar, tooltip as pulled in).
  - `apps/web/src/components/*` (Sentra primitives): `page-header.tsx`, `data-table.tsx`, `filter-bar.tsx`, `empty-state.tsx`, `error-state.tsx`, `loading-state.tsx` (skeleton variants), `severity-badge.tsx`, `status-badge.tsx`, `theme-toggle.tsx`.
  - `apps/web/src/components/shell/*`: `app-sidebar.tsx`, `org-switcher.tsx`, `project-switcher.tsx`, `breadcrumbs.tsx`, `centered-layout.tsx`.
  - `apps/web/src/app/dev/ui/page.tsx`.
  - `apps/web/src/app/orgs/[slug]/layout.tsx`, `apps/web/src/app/orgs/[slug]/projects/[projectSlug]/layout.tsx`.
- Tokens:
  - shadcn semantic set in OKLCH: background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, sidebar-*.
  - Severity: `critical`, `high`, `medium`, `low`, `info` (info also covers none/unknown). Per level: `--severity-<l>` (solid), `--severity-<l>-foreground` (text on solid), `--severity-<l>-subtle` (tint background), `--severity-<l>-border`. Exposed as Tailwind colors (`bg-severity-critical`, etc.).
  - Status: finding `open` / `resolved`; `kev`; investigation run `queued` / `running` / `succeeded` / `failed`. Same four-token shape where used as badges.
  - Density: table row 32–36px, body 13–14px, compact spacing scale; radius modest (about 6px).
- Primitive contracts (props indicative, finalized in PR1):
  - `PageHeader({ title, description?, actions? })`.
  - `DataTable<T>({ columns: { key, header, cell(row), className? }[], rows: T[], rowKey(row), rowAccent?(row) => "critical" | "high" | undefined, empty?: ReactNode, loadMoreHref?: string | null, loadMoreLabel?, testId? })`. Server component; renders `EmptyState` when `rows` is empty and `empty` is given; renders a "Load more" link when `loadMoreHref` is set. Passes through `data-testid` so existing selectors can be preserved.
  - `FilterBar({ action?, children, submitLabel })`: GET `<form>` layout wrapper; works without JavaScript.
  - `EmptyState({ title, description?, action?, testId? })`, `ErrorState({ title, message, correlationId?, testId? })` (shows "Reference: <id>" as pages do now), `LoadingState` skeleton variants (table rows, page header, detail).
  - `SeverityBadge({ level })`, `StatusBadge({ status })`: always render a visible text label; color is secondary.
  - `ThemeToggle()`: client component, three options, writes cookie (`Path=/`, `SameSite=Lax`, 1-year max age, not `HttpOnly` so the client can set it; contains no sensitive data) and updates `<html>` class immediately.
- Request and data flow:
  - Root `layout.tsx` reads the theme cookie via `cookies()` and sets the `<html>` class; loads fonts and `globals.css`.
  - `/`, `/orgs/new`, `/invitations/accept`: `CenteredLayout` (logo/wordmark text, theme toggle, centered content column). No sidebar.
  - `/orgs/[slug]/layout.tsx`: `fetchOrg(slug)` (React `cache()`-wrapped) + first page of the user's orgs (existing `GET` used by `/`, limit ~20). Renders sidebar with org nav (Projects, Members, Audit events), org switcher, breadcrumbs, and children.
  - `/orgs/[slug]/projects/[projectSlug]/layout.tsx`: `fetchProject` (cached) + first page of `listProjects(org.id)` (limit ~20). Sidebar switches to project nav (Overview, Findings, Investigations) with a back link to the org; project switcher in the header.
  - Breadcrumbs are derived from route segments plus already-fetched org/project names; no extra API calls.
- API, event, and storage contracts: none changed. If the org-list or project-list helpers do not accept a page-size parameter, use the API's default page and cap rendering to 20; do not add API parameters in this story.
- Compatibility and migration considerations:
  - Tailwind preflight will reset default element styles on existing page bodies. Acceptable for this story (bodies are rebuilt in SENTRA-35..38), but pages must remain readable and usable: forms, links, tables, and buttons get sensible base styles in `globals.css` `@layer base`.
  - Every existing `data-testid` and every element the e2e specs use (labels, button names, link text) must remain. Pages keep their own error/empty markup.
  - Next.js may generate agent files during setup; `agentRules: false` is already set; do not commit any generated `AGENTS.md`/`CLAUDE.md`.

## Workload and targets

| Dimension                 | Expected value or range                                                                                                                             | Source or assumption      | Validation                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Traffic and peak requests | Unknown; local/dev scale                                                                                                                            | No production traffic yet | N/A for this story                                                                                                                        |
| Extra API calls           | +1 org-list call on entering an org route; +1 project-list call on entering a project route; 0 extra for org/project lookups (deduped by `cache()`) | Design                    | Check API request logs while navigating locally: org/project lookup appears once per request                                              |
| Data size                 | Switcher renders at most 20 items per list                                                                                                          | Design                    | Unit/e2e with a user having >20 orgs is not required; cap enforced in code and covered by a unit test of the slicing helper if one exists |
| Latency target            | No measurable regression in page render beyond the added list call                                                                                  | Assumption                | Manual comparison in dev; not gated                                                                                                       |
| Client bundle             | No table JS on the client; client components limited to theme toggle, sidebar/sheet, dropdown menus                                                 | Design                    | Inspect `next build` output for route sizes in PR description                                                                             |
| Availability              | Shell must never block a page from rendering when list/lookup calls fail                                                                            | Requirement               | e2e against the unavailable-API dev server (existing pattern)                                                                             |

## Edge cases and failure behavior

| Scenario                                    | Expected behavior                                                                                                                                              | Verification                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| API unavailable when entering an org route  | Layout renders a minimal shell (no org name, switcher shows only "All organizations"); page renders its existing `api-unavailable` message with correlation ID | Existing e2e unavailable-API tests still pass                       |
| Org-list call fails but org lookup succeeds | Switcher shows the current org plus "All organizations"; no error banner in the shell                                                                          | Unit/component test of switcher fallback; manual check              |
| Project-list call fails                     | Project switcher shows current project plus "All projects"                                                                                                     | Same                                                                |
| User is not a member / org not found        | Layout shows no org name or nav data beyond what the API returned (nothing); page renders its existing not-found/forbidden state                               | Existing e2e (organizations, tenant isolation) pass                 |
| User belongs to more than 20 orgs/projects  | Switcher shows first 20 and the "All..." link                                                                                                                  | Code review + manual                                                |
| Invalid theme cookie value                  | Treated as `system`                                                                                                                                            | Unit test of the theme cookie parser                                |
| No cookie, OS dark                          | Dark tokens via CSS media query, no flash                                                                                                                      | Manual reload; axe dark run uses cookie, manual check covers system |
| JavaScript disabled or not yet hydrated     | Navigation, filters (GET forms), and "Load more" links work; theme toggle and mobile sheet need JS                                                             | Manual check with JS disabled on findings page                      |
| Narrow viewport (below `md`)                | Sidebar collapses into a sheet opened from a header button                                                                                                     | Manual check + screenshot                                           |
| `/dev/ui` in production build               | Returns 404                                                                                                                                                    | Manual `next build && next start` check                             |
| Very long org/project names                 | Truncated with ellipsis in sidebar/switcher/breadcrumbs; full name in `title`                                                                                  | Shown on `/dev/ui` or manual                                        |

## Security, observability, and rollout

- Authorization, tenant isolation, sensitive data, and abuse limits:
  - Layouts use the same authenticated server-side API helpers (`callApi`/`apiGet` with the session token) as pages. The shell can only display data the API already authorizes for the user; no new endpoint, route handler, or token-forwarding path.
  - Layout must not render org/project names when the lookup is not `ok`.
  - Theme cookie holds only `light`/`dark`/`system`; parsed against an allow-list before use in `className`.
  - `/dev/ui` uses static fixture data only (no API calls, no real tenant data) and 404s in production.
  - New dependencies are mainstream (Tailwind, Radix via shadcn, lucide, axe dev-only); run `task security` as part of DoD.
- Logs, metrics, traces, and alerts: no new server logic beyond existing API helpers, which already log failures with correlation IDs. No new metrics. Layout fallbacks do not add new log lines unless the existing helper already logs.
- Rollout, migration, rollback, and operational owner: ships with the web app; no flags, no migrations. Rollback is reverting PR2 (shell) and/or PR1 (foundation). Owner: apps/web.

## Acceptance criteria

PR1 (foundation):

- [x] Tailwind v4 and shadcn/ui are configured in `apps/web` (`components.json`, `globals.css`, `cn` helper); `task web:lint`, `typecheck`, `test`, `format:check` pass.
- [x] Light and dark token sets exist, including severity (critical, high, medium, low, info) and status (open, resolved, KEV, queued, running, succeeded, failed) tokens, each usable as Tailwind colors.
- [x] Theme defaults to the OS preference; the toggle offers light, dark, system; the choice persists across reloads via cookie with no flash of the wrong theme; an invalid cookie falls back to system.
- [x] Primitives exist and are shown on `/dev/ui` in all variants: PageHeader, DataTable (with critical/high row accents, empty slot, Load more), FilterBar, EmptyState, ErrorState (with reference ID), LoadingState skeletons, SeverityBadge, StatusBadge, ThemeToggle.
- [x] Severity and status badges always show a text label.
- [x] `/dev/ui` returns 404 in a production build.
- [x] axe (WCAG 2 A/AA tags) reports no violations on `/dev/ui` in light and dark.

PR2 (shell):

- [ ] All `/orgs/[slug]/**` routes render inside the app shell with sidebar navigation (org: Projects, Members, Audit events; project: Overview, Findings, Investigations), switcher, and breadcrumbs showing org/project names.
- [ ] The org switcher lists up to 20 of the user's orgs plus "All organizations"; the project switcher lists up to 20 projects plus "All projects"; both mark the current item.
- [ ] Org and project lookups run once per request (layout and page share the call).
- [ ] If list or lookup calls fail, pages still render their existing error states and the shell degrades to current-item plus "All..." links without showing data the API did not return.
- [ ] `/`, `/orgs/new`, `/invitations/accept` use the centered layout with the theme toggle.
- [ ] Finding detail header uses the severity accent for critical and high findings (accent only; body unchanged).
- [ ] Below the `md` breakpoint, the sidebar opens as a sheet.
- [ ] All existing e2e specs pass unchanged (same `data-testid`s and accessible names).
- [ ] axe reports no WCAG 2 A/AA violations on one shell route (org page) in light and dark.
- [ ] PR includes Playwright screenshots of `/dev/ui` and the org/project shell in light and dark, committed under `docs/features/SENTRA-34-ui-foundation/screenshots/`.

## Implementation plan

Dependency-ordered; each step is independently verifiable.

PR1: `feature/SENTRA-34-ui-foundation` (foundation)

1. Tailwind v4 + shadcn init. Add Tailwind v4 and `@tailwindcss/postcss`, `postcss.config.mjs`, `globals.css`, `components.json` (aliases `@/components`, `@/lib`), `src/lib/utils.ts`. Verify current setup steps for Next 16 + Tailwind v4 + shadcn via context7 and record versions here. Remove inline styles from root `layout.tsx` in favor of base styles. Expected: app builds; existing pages render with base styles; e2e green. Tests: existing suite.
2. Tokens and themes. Define semantic, severity, and status tokens for light and dark in `globals.css` (OKLCH), `@theme inline` mappings, `@custom-variant dark`, base layer styles for forms/tables/links on legacy pages. Fonts via `next/font`. Expected: tokens usable as utilities. Tests: none beyond build; covered by axe in step 6.
3. Theme mechanism. `src/lib/theme.ts` (cookie name, allow-list parser), root layout sets `<html>` class, `ThemeToggle` client component (shadcn dropdown-menu). Expected: three modes, persisted, no flash. Tests: Vitest unit tests for the parser (valid values, invalid, missing).
4. Stock shadcn components via the `shadcn` CLI/MCP: button, badge, table, dropdown-menu, sheet, skeleton, separator, breadcrumb, sidebar, tooltip. Expected: compile, lint clean.
5. Sentra primitives: PageHeader, DataTable, FilterBar, EmptyState, ErrorState, LoadingState, SeverityBadge, StatusBadge. Map existing domain values (e.g. `severityLabel` outputs, KEV status, investigation run states) to badge variants in a small pure function. Expected: server-component friendly (no `"use client"` except where required). Tests: Vitest unit tests for the domain-to-variant mapping functions; DataTable row-accent selection logic if extracted as a pure function.
6. `/dev/ui` page with static fixtures for every primitive and variant; `notFound()` in production. Add `@axe-core/playwright` and `e2e/accessibility.spec.ts` running WCAG 2 A/AA tags on `/dev/ui` with theme cookie `light` and `dark`. Expected: zero violations. Tests: the axe spec; manual production 404 check.
7. PR1 docs/screenshots: light and dark screenshots of `/dev/ui`; update this spec with verified versions and any changed assumptions.

PR2: branched from PR1 (shell)

8. Cache lookups: wrap `fetchOrg` and `fetchProject` (and `fetchProjectScope` if used by layouts) in React `cache()`. Expected: one call per request. Tests: existing unit/e2e; manual check of API logs.
9. Org layout `orgs/[slug]/layout.tsx` with `AppSidebar` (org nav), `OrgSwitcher` (first 20 + "All organizations"), `Breadcrumbs`, mobile sheet; degrade on failures. Tests: Vitest for any pure helpers (breadcrumb derivation, list capping/fallback); existing e2e.
10. Project layout `projects/[projectSlug]/layout.tsx` with project nav, `ProjectSwitcher`, extended breadcrumbs. Tests: as step 9.
11. Centered layout for `/`, `/orgs/new`, `/invitations/accept` (route group or per-page wrapper, without changing URLs).
12. Finding detail header severity accent (critical/high) in `findings/[findingId]` without restructuring the body.
13. Extend `e2e/accessibility.spec.ts` with the org page in light and dark; add a shell smoke e2e (sidebar links present, switcher shows current org, breadcrumbs show names) and a degraded-shell check using the existing unavailable-API setup. Run full e2e.
14. PR2 screenshots (org and project shell, light and dark, mobile sheet), learning note `docs/learning/` on theming without flash, token layering, and server-rendered shells.

## Verification

- Manual checks and expected results:
  - Toggle light/dark/system; reload; no flash; OS switch while on system updates the page.
  - Navigate org to project to findings to detail: breadcrumbs and switcher reflect names; switcher "All..." links go to `/` and the org page.
  - Stop the API (or use the unavailable-API server): pages show existing error states inside a degraded shell.
  - Resize below `md`: sidebar becomes a sheet.
  - Disable JavaScript: links, filters, Load more still work.
  - `next build && next start`: `/dev/ui` is 404.
- Automated tests and what they prove:
  - Vitest: theme cookie parser; domain-to-badge mappings; breadcrumb/switcher pure helpers.
  - Playwright: all existing specs unchanged (no regressions, selectors intact); axe on `/dev/ui` and org page in both themes (AA contrast including severity badges); shell smoke and degraded-shell tests.
- Load or failure tests: N/A beyond the unavailable-API e2e.

## Definition of done

- `task lint`, `task format:check`, `task typecheck`, `task test`, `task web:test:e2e` (with `task stack:up` and `task stack:bootstrap`), `task security`, and `task fallow` pass; fallow findings fixed, not suppressed.
- No generated `AGENTS.md`/`CLAUDE.md` committed.
- Screenshots committed and linked by commit-SHA permalinks in the PRs.
- This spec updated with verified versions and assumption outcomes; learning note added with PR2.
- YouTrack SENTRA-34 updated with acceptance criteria and spec link.

## Open questions and assumptions to validate

- **Verified (PR1):** no-flash theming in all three modes. Mechanism changed from the draft: dark values are declared once per token with CSS `light-dark()`, and `color-scheme` is set by `<html class="light|dark">` (from the cookie, server-rendered) or left as `light dark` for system. This removed the duplicated dark block that `task fallow` flagged. Checked with Playwright against `next dev`: cookie `light`/`dark` gives the matching `<html>` class in the server HTML; no cookie follows `prefers-color-scheme`; forced `light` with OS dark stays light, forced `dark` with OS light stays dark. Not checked: a visual no-flash recording on slow networks. Review found Lightning CSS (inside Tailwind) compiles `light-dark()` to a `--lightningcss-light/dark` custom-property fallback, so native `light-dark()` support is not required; the `.light`/`.dark` classes only work on `<html>` because tokens resolve at `:root`.
- **Verified (PR1):** `@custom-variant dark` with nested `@media` and `:where(:root:not(.light))` works in Tailwind 4.3.3. A `dark:block`/`dark:hidden` icon swap on the toggle follows the cookie and the OS correctly in all combinations above.
- **Verified (PR1):** Geist and Geist Mono load through `next/font/google` in Next 16.3.8 (build and dev succeed; no `geist` package needed).
- **Verified (PR1):** `shadcn@4.21.4` `add` works with Tailwind 4.3.3, React 19.3 and Next 16.3.8 using a hand-written `components.json` (new-york style, `tailwind.config` empty). Two quirks: the generated components imported `cn` from a bogus npm package `cn` (rewritten to `@/lib/utils`, package removed), and `table.tsx` got `"use client"` (removed so tables stay server components). Output is run through Prettier.
- **Verified (PR1):** `/dev/ui` returns 404 under `next build && next start`; axe (wcag2a, wcag2aa, wcag21a, wcag21aa) reports zero violations in light and dark.
- **Assumed:** existing org-list and project-list helpers return a page usable for the switcher without API changes. Validate in PR2 step 9; if not, cap client-side and do not change the API.
- Future options (not in scope): TanStack Table for client table state (e.g. bulk triage selection); switcher search; command palette; severity summary charts (SENTRA-37).

## PR1 implementation notes

- Versions: tailwindcss and @tailwindcss/postcss 4.3.3, radix-ui 1.7.0, lucide-react 1.55.0, class-variance-authority 0.7.1, clsx 2.1.1, tailwind-merge 3.7.0, tw-animate-css 1.4.0, @axe-core/playwright 4.13.0 (dev), shadcn 4.21.4 (existing root devDependency), Next 16.3.8.
- Deviation, step 4: only `button`, `badge`, `table`, `dropdown-menu`, `skeleton` were kept. `sheet`, `sidebar`, `breadcrumb`, `separator`, `tooltip`, `input` and the `use-mobile` hook were removed because nothing consumes them until PR2 and `task fallow` rejects unused files; re-add them with `shadcn add` in PR2 step 9. `dropdown-menu` was pruned to the parts used (radio group/item); `table` lost caption/footer and the `*Variants` exports were un-exported for the same reason.
- Deviation, step 2: tokens use `light-dark()` (see Open questions) instead of two declaration blocks.
- Legacy page bodies keep their 640px column through a `body:not(:has([data-layout="wide"]))` rule in `globals.css`; `/dev/ui` opts out with `data-layout="wide"`. Remove this rule when the shell lands in PR2.
- `/dev/ui` is behind the sign-in proxy like every route; the axe spec sets a placeholder `sentra_session` cookie (the proxy only checks presence and `/dev/ui` makes no API calls).
- Status tokens: `resolved` and `kev` have their own palettes; `open`, `queued`, `running`, `succeeded`, `failed` alias severity/resolved tones. Investigation API status `completed` maps to the `succeeded` badge.
- `src/css.d.ts` declares `*.css` because TypeScript 6 rejects the side-effect import of `globals.css` on a fresh checkout (`next-env.d.ts` is gitignored and generated).
- Screenshots: `screenshots/dev-ui-light.png`, `screenshots/dev-ui-dark.png` (the Next dev overlay button is visible bottom-left).
