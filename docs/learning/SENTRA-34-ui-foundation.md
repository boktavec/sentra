# SENTRA-34: UI foundation (tokens, theme, app shell)

## What was built

`apps/web` now has a design system (Tailwind v4 + shadcn/ui, light and dark tokens including a severity/status scale), shared primitives shown on `/dev/ui`, and an app shell. Every `/orgs/[slug]/**` route renders inside a sidebar with org or project navigation, an org switcher, a project switcher, and breadcrumbs; `/`, `/orgs/new` and `/invitations/accept` use a small centered frame. Existing page bodies were not rebuilt; they run inside the shell until SENTRA-35..38 replace them.

## Why it is designed this way

- **Theming without a flash.** The theme is a cookie (`light`, `dark`, `system`) that the root layout reads on the server and turns into a class on `<html>`. Because the server already knows the choice, the first byte of HTML carries it: no inline script, no `localStorage`, no hydration swap. For `system` no class is set and CSS follows `prefers-color-scheme`. Each token declares both values once with `light-dark()`, and `color-scheme` picks which one applies, so there is no duplicated dark block to keep in sync. The cookie is allow-listed before it reaches `className`.
- **Token layers.** Components use semantic names (`--background`, `--primary`, `--severity-critical`), never raw colors. Severity and status each have four tokens (solid, text on solid, tint, border), which is enough to build a badge, a row accent, and a callout from the same source. Changing the look of "critical" is one edit.
- **A server-rendered shell.** The layouts fetch the org, the project and the first page of each list on the server with the session the page already uses. No new endpoint, no token handed to the browser, no client fetch for the switcher. Only the interactive parts (sidebar toggle, dropdown menus, theme toggle, active-link highlighting) are client components, and they receive plain data as props.
- **One lookup per request.** The layout and the page both need the org and the project. `fetchOrg` and `fetchProject` wrap the API call in React `cache()`, which memoizes per request, so the API sees one call. The 404-to-`notFound()` step stays outside the cached function so the memo holds only data.
- **Show only what the API returned.** A missing or foreign org is a 404 thrown before any shell renders, so a non-member sees the same page as for a nonexistent org. If the lookup fails (API down) the shell shrinks to the wordmark, an "All organizations" link and breadcrumbs, and the page shows its own error with the correlation ID. If only the list call fails, the switcher shows the current item. Names never come from the URL; the breadcrumb for a finding says "Finding", not the id.
- **Project header lives in the project layout.** The org layout cannot know the project name (a parent layout does not see child params), so on project routes it steps aside (`OrgFrame` checks `useParams()`) and the project layout renders the full header. That keeps names server-rendered and correct on first paint.
- **Legacy styles are scoped.** Tailwind's preflight strips default element styling, so old page bodies needed some restored. Those rules first lived globally and leaked into the shell (bullets on menus, underlined link buttons). They now apply only inside a `data-legacy` wrapper, in the base layer so any utility class still wins. Deleting the block and the wrapper later removes the legacy look in one step.

## Alternatives considered

- `next-themes`: adds a dependency and an inline script, and stores the choice where the server cannot see it. Rejected.
- Client-fetched switchers through a new route handler: more surface and token handling for no gain at 20 items. Rejected; links to the full lists cover the rest.
- A single header rendered by the org layout with a client-side context fed by the project layout: it would paint the project name only after hydration. Rejected for the two-layout split above.
- TanStack Table for data tables: not needed while sorting and filtering are URL parameters. Recorded as a future option.

## Tradeoffs

- The page bodies still carry some duplicated navigation links (for example "All organizations"); two body links that collided with sidebar items in strict accessible-name tests (Members on the org page, Investigations on the project page) were removed because the sidebar now provides them.
- The switcher list is fetched when a layout renders (entering an org or project), not on every click, so a project created in another tab appears after the next navigation into the project.
- Two header implementations exist (org layout and project layout); they share `ShellHeader`, so the cost is a client-side `useParams()` check.

## Scaling implications

One extra list call when entering an org route and one when entering a project route; org and project lookups are deduplicated. Layouts persist across client navigation, so the cost is paid on entry, not per click. The switcher renders at most 20 items.

## Failure and security considerations

- Tenant data in the shell is whatever the existing authorized helpers return; nothing new crosses the browser boundary.
- The theme and sidebar cookies hold only non-sensitive state.
- Axe checks run in light, dark and system (with an OS-dark preference) on the org page, so severity colors and shell chrome are contrast-checked in the real DOM.

## Key concepts

- Per-request memoization with `cache()` versus caching across requests.
- Why layouts cannot read child params, and how `useParams()` in a client component bridges it.
- CSS layers: utilities beat base styles regardless of selector specificity, which is why scoped base rules are safe.
- `light-dark()` plus `color-scheme` as a single-source way to declare theme tokens.
