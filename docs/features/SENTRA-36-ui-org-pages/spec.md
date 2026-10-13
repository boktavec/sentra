# SENTRA-36: Revamp organization pages

- Status: Implemented across three stacked PRs (PR3 in review)
- YouTrack: [SENTRA-36](http://localhost:8080/issue/SENTRA-36)
- Owner: apps/web
- Depends on: [SENTRA-34](http://localhost:8080/issue/SENTRA-34) (UI foundation, merged), see [`docs/features/SENTRA-34-ui-foundation/spec.md`](../SENTRA-34-ui-foundation/spec.md). Builds on the patterns of [SENTRA-35](http://localhost:8080/issue/SENTRA-35), see [`docs/features/SENTRA-35-ui-entry-onboarding/spec.md`](../SENTRA-35-ui-entry-onboarding/spec.md).
- Branch / worktree: `feature/SENTRA-36-ui-org-pages` at `sentra-worktrees/SENTRA-36-ui-org-pages` (PR1); PR2 and PR3 branch from the previous PR (stacked).

## Problem and outcome

`/orgs/[slug]`, `/orgs/[slug]/members` and `/orgs/[slug]/audit-events` render inside the SENTRA-34 app shell, but their bodies are unstyled legacy markup wrapped in `LegacyPage` (`[data-legacy]`) by `OrgFrame`. They also have real usability gaps:

- No way to sign out anywhere under `/orgs/**` (SENTRA-35 follow-up 3, owned by this story).
- Remove, Leave and Revoke act on one click with no confirmation; Leave is irreversible for a non-admin.
- Audit filters are raw UTC ISO-8601 text inputs and a raw actor UUID; an invalid filter (API 400) is shown as "temporarily unavailable"; times render in the server's timezone via `toLocaleString`.
- A failed pending-invitations load silently shows an empty list.

Done means:

- The three pages are rebuilt with the design system (`PageHeader`, `DataTable`, `FilterBar`, `EmptyState`, `ErrorState`, `StatusBadge`, `Button`, `Card`/`Input`/`Label`, plus shadcn `dialog` and `alert-dialog`) and no longer render inside `LegacyPage`. They meet WCAG 2 A/AA in light and dark.
- A visible "Sign out" button is in the shell header on every org and project route.
- Project creation and invitations happen in dialogs; destructive member actions are confirmed.
- Audit events keep strict UTC in the URL and the API, display local time with a zone label and an exact-UTC tooltip, use friendly filters, and show invalid filters as validation, not as an outage.

## Scope

- In scope:
  - `OrgFrame`: replace `LegacyPage` with a plain design-system page column.
  - `ShellHeader`: a "Sign out" POST-form button (shared by org and project layouts).
  - Rebuild of the org page (`page.tsx`, `projects/new-project-form.tsx`), members (`members/page.tsx`, `invite-form.tsx`; `actions.ts` copy/return-shape only if needed) and audit events (`audit-events/page.tsx`).
  - shadcn `dialog` and `alert-dialog` (and `select` only if used) through the shadcn CLI.
  - New client components: `LocalTime`, a confirm-submit wrapper, the invite dialog, the project dialog, a copy-link button, the audit filter form.
  - Pure helpers in `src/lib` with Vitest tests (time conversion, audit filter validation, known audit actions, actor display).
  - e2e updates for the changed flows; axe cases; screenshots through `screenshotPath`.
  - Learning note (PR3).
- Out of scope (non-goals):
  - Any API, auth, session, event or data-model change.
  - Actor display names in audit events.
  - An account menu or showing the user's email.
  - Project overview, findings and investigations pages (SENTRA-37, SENTRA-38). The project layout keeps `LegacyPage`.
  - No-JS project creation and no-JS invitations (see Known limitations).
  - Client table state (sorting, selection), audit export, saved filters.
- Follow-ups (to record in YouTrack, not implemented here):
  1. Actor display names in audit events: API contract decision (join to users, departed members, what non-admins may see).
  2. API-published audit action enum to replace the web constant used by the datalist.
  3. Account menu with the signed-in email (folds in SENTRA-35 follow-up 4).
  4. Optional no-JS fallback route `/orgs/[slug]/projects/new`, if no-JS project creation turns out to matter.
- Dependencies and related stories: SENTRA-34 and SENTRA-35 (merged). SENTRA-37/38 remove the last `LegacyPage` usage.

## Decisions and alternatives

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Story depth | Visual rebuild plus UX improvements in `apps/web` only, no API change | Visual-only rebuild; rebuild plus actor names via an API change | Same as SENTRA-35; no security-boundary change. Audit actors stay IDs (follow-up 1). |
| Sign-out in the shell | Visible "Sign out" POST form (`action="/auth/logout"`) in `ShellHeader` next to the theme toggle. Below `sm` the label is visually hidden and only the icon shows; the accessible name stays "Sign out" | Account dropdown in the sidebar footer; plain form in the sidebar footer | Works without JS at every width, one per page, same markup as `CenteredLayout`, existing specs unchanged. An account menu waits until there is account data to show (follow-up 3). |
| Destructive member actions | shadcn `AlertDialog` confirm for Remove, Leave and Revoke, naming the target and the consequence. The row button is the form's submit button; with JS it opens the dialog instead of submitting, and the dialog's confirm submits the same server-action form. Without JS it submits directly, as today | Server-rendered confirm step via `?confirm=`; confirm Leave only | Standard accessible pattern (focus trap, focus return, `alertdialog` role from Radix). No-JS never gets worse than today. e2e gets one extra click. Change role stays unconfirmed (reversible; the API guards the last admin). |
| Time semantics | URL and API values stay strict UTC ISO; the UI displays times in the viewer's local timezone | UTC everywhere | User decision. |
| Local time mechanism | Server renders `<time dateTime="<ISO>Z">YYYY-MM-DD HH:mm:ss UTC</time>`; a `LocalTime` client component reformats after mount (in an effect, so no hydration mismatch) to local time with a short zone name, with the exact UTC ISO in `title`. Filter inputs are `datetime-local`; a client submit handler converts them to UTC ISO, and on load the client fills the inputs from the UTC URL values in local time. Without JS, the server treats a bare `YYYY-MM-DDTHH:mm[:ss]` as UTC, and a hint says "Times in UTC"; after hydration it reads "Times in your time zone (<IANA zone>)" | Timezone cookie with server-side local rendering and conversion; local display with UTC date-only filters | No new state, cookie or dependency; no-JS stays correct and clearly labelled; zone label plus UTC tooltip keeps screenshots unambiguous. Cost: a brief UTC-to-local text swap on load. The cookie option would need server-side wall-clock-to-UTC conversion across DST (a tz library or Temporal). |
| Project creation | "New project" header action opens a shadcn `Dialog` containing the existing form (name, slug suggestion via `slugify`, slug constraints, "cannot be changed later" hint, `aria-busy` pending state, `project-form-error`). The empty state's action opens the same dialog | Inline card under the list; dedicated `/orgs/[slug]/projects/new` page | User asked for a modal; keeps the page focused on the list. No-JS project creation is a Known limitation (follow-up 4 if needed). |
| Audit "Action" filter | Text input with a `<datalist>` of known actions from one `lib` constant; any value accepted | Select from a static list; free text as today | Prevents typos without making the web app the owner of the API's action vocabulary; unknown future actions can still be typed. Works without JS. |
| Invite flow | Admin-only "Invite member" header action opens a `Dialog` with Email and Role. On success the dialog shows "Invitation sent to <email>", the link (mono, selectable) with "Copy link", "Shown only once", and a "Done" button. While the link is shown, Esc and outside-click dismissal are blocked; only Done closes it. The pending list refreshes behind the dialog (`revalidatePath`, unchanged) | Inline card above the members table; dialog plus a page banner carrying the link | Consistent with project creation. The email is the primary channel, and an admin can revoke and re-invite, so losing the link is recoverable. No-JS invite is a Known limitation. |
| Copy link | Clipboard API button with an announced "Copied" status (`aria-live="polite"`); the link stays selectable text | No copy button | Usable without JS (select and copy manually). |
| Pending invitations load failure | Inline `ErrorState` with "Reference: <correlation id>" inside the invitations section; the members table still renders | Silent empty list (today); fail the whole page | Makes the failure visible without blocking member management. |
| Audit invalid filters | Validate in the web before calling the API (parseable dates, From < To, actor ID is a UUID, action 1–100 chars); render a form-level alert. An API 400 `invalid_input` also renders as "Check the filters" validation, not as `api-unavailable` | Leave as today | A bad filter is user input, not an outage. |
| Non-admin on audit events | `EmptyState` "You do not have access to audit history." (same text as today) | `notFound()` | Keeps the current text that a non-admin can see; no route behavior change. |
| PR shape | Three stacked PRs: PR1 frame + Sign out + org page (+ `dialog`); PR2 members (+ `alert-dialog`); PR3 audit events + learning note | Single PR; two stacked PRs | Each page has a distinct risk (dialog no-JS path, destructive confirms, timezone conversion); smaller reviews and fix loops. Cost: stack rebases and three review rounds. |
| New components | shadcn `dialog`, `alert-dialog` via the CLI (Radix already installed through `radix-ui` 1.7.0). Known CLI quirk (**Verified** in SENTRA-34/35): `shadcn add` adds a bogus `cn` npm dependency and imports `cn` from it; revert it and import from `@/lib/utils`. Prune unused exports (fallow) | Hand-written dialogs | Consistent with SENTRA-34/35; no new runtime package beyond what `radix-ui` already ships. |
| ADR | Not required | — | Local to `apps/web` and reversible; this spec records the choices. |

## Architecture and contracts

- Affected components and ownership: `apps/web` only. Owner: apps/web.
  - `src/components/shell/org-frame.tsx`: wraps org-route children in a design-system column (for example `mx-auto w-full max-w-5xl px-4 py-6 md:px-6`, no `data-legacy`). Until PR2/PR3 land, members and audit-events pages wrap their own body in `LegacyPage`. `LegacyPage` stays for the project layout (SENTRA-37/38).
  - `src/components/shell/shell-header.tsx`: after the theme toggle, a `<form method="post" action="/auth/logout">` with a `Button` containing a `LogOut` icon (`aria-hidden`) and the text "Sign out" (`sr-only` below `sm`). Consider extracting a shared `SignOutButton` used by both `CenteredLayout` and `ShellHeader` (exactly one per page in both frames).
  - Org page (`src/app/orgs/[slug]/page.tsx`):
    - Header: org name as the single `h1` with `data-testid="org-name"`; mono slug `org-slug`; role as a badge `org-role` whose text stays `admin`/`member`. `PageHeader.title` is a string and has no test-ID prop: extend `PageHeader` minimally (for example `titleTestId`) or render the title node as the pages need; do not duplicate the `h1`.
    - Header actions: "New project" (dialog trigger); for admins an "Audit history" link (the e2e clicks this; the sidebar item is "Audit events").
    - Projects: `DataTable` with `testId="project-list"`, columns name (link named by project name) and slug (mono). The web `Project` type has only `id`, `name`, `slug`, so no created column. "More projects" link when `nextCursor` is set.
    - Empty (first page): `EmptyState testId="no-projects"` (text keeps "This organization has no projects yet."), action opens the same dialog. Only one trigger may be named "New project" at a time (strict mode): the empty-state action uses a distinct name, for example "Create your first project", or the header action is the only trigger.
    - Errors: `ErrorState testId="api-unavailable"` with `correlationId` for both the org lookup and the project list.
    - `projects/new-project-form.tsx` renders inside the `Dialog`; labels "Project name" and "Project slug" unchanged; submit button "Create project" (exactly one); on success the action redirects to the project page as today.
  - Members (`src/app/orgs/[slug]/members/page.tsx`, `invite-form.tsx`):
    - `PageHeader` "Members"; admins get an "Invite member" header action.
    - Members `DataTable` with `testId="members"`; rows keep `data-testid="member-row"` and `data-user-id`; columns: name with "(you)", Email (admins only; column header "Email"), role (`member-role`, text `admin`/`member`), actions.
    - Admin actions: role `<select>` (accessible name "Role for <name>") plus "Change role"; "Remove" (others) or "Leave" (yourself). Members: "Leave" on their own row only. Remove/Leave confirm via `AlertDialog` (copy names the person and org and the consequence, for example "Remove Jane from Acme? They lose access immediately. You can invite them again."; Leave: "Leave Acme? You lose access immediately and need a new invitation to return."). Confirm button text equals the action ("Remove", "Leave"); the dialog's cancel is "Cancel".
    - `members-error` stays a `role="alert"` with the same messages, styled as an inline alert.
    - Invitations (admins): pending invitations `DataTable` (`invitations`, rows `invitation-row`), columns email, role, expires (`LocalTime`), "Revoke" with `AlertDialog` confirm. Hidden when the list is empty (as today: `invitations` count 0 after acceptance). Load failure: `ErrorState` with reference inside the section.
    - Invite dialog: labels "Email" (the only label containing "Email" in the dialog; `getByLabel` is substring) and role select named "Invitation role"; submit "Invite" (`aria-busy` while pending, constant label); errors `invite-error`; success state `invite-link-box` containing `invite-link` (the full URL as text), "Copy link", "Shown only once", "Done".
    - "More members" pagination unchanged.
  - Audit events (`src/app/orgs/[slug]/audit-events/page.tsx`):
    - `PageHeader` "Audit history".
    - Filter form (client component, GET to the same URL, wrapped in `FilterBar` layout): "From" and "To" (`datetime-local`), "Actor ID" (mono text), "Action" (text with `list` to a `<datalist>`), "Result" select (All / Success / Failed); submit "Filter". Labels must stay matchable by `getByLabel("Result")` and `getByLabel("Action")` (no other label containing those words). Timezone hint below the filters.
    - Client submit: converts From/To local values to UTC ISO (`toISOString()`, seconds precision) and writes them into the submitted query; leaves empty fields out.
    - Server: parses the query with a pure helper. `from`/`to` accept strict UTC ISO (JS path) or a bare `YYYY-MM-DDTHH:mm[:ss]` treated as UTC (no-JS path) and normalized to strict UTC ISO before the API call. Validation errors render a form-level alert (`data-testid="audit-filter-error"`) and skip the API call. An API 400 `invalid_input` renders the same alert.
    - Table: `DataTable testId="audit-events"`; columns Time (`LocalTime`), Action (mono), Result (`StatusBadge`: `success` maps to the `succeeded` variant (label "Succeeded"), `failed` to "Failed", plus the failure code in mono), Actor (first 8 chars of the ID in mono, full ID in `title`, "You" when it equals `/v1/me`), Target (type plus mono ID). `no-audit-events` empty state; `api-unavailable` `ErrorState` for real failures; "More audit events" link keeps the current filters (normalized UTC values).
    - Non-admin: `EmptyState` with "You do not have access to audit history."
    - The page adds one `GET /v1/me` call (already used by members) for the "You" marker; if it fails, actors render without "You" (no error).
  - New helpers (indicative, `src/lib/`): `local-time.ts` (format UTC ISO for the server fallback; format local with short zone name; local input value from UTC ISO; local input value to UTC ISO), `audit-filters.ts` (parse and validate the query; normalize bare values to UTC; build the next-page query; reuse `auditEventsQuery`), `audit-actions.ts` (known actions constant), actor display helper. All pure and unit-tested.
  - New components: `src/components/local-time.tsx`, `src/components/confirm-submit.tsx` (AlertDialog around a submit button), `src/components/copy-button.tsx`, `src/components/ui/dialog.tsx`, `src/components/ui/alert-dialog.tsx`; page-local dialogs (project, invite) and the audit filter form next to their pages.
- Request and data flow: unchanged server-action and GET-form flows. Org page: `fetchOrg` (cached) + `listProjects`. Members: `fetchOrg`, `/v1/me`, members page, invitations (admins). Audit: `fetchOrg`, `/v1/me` (new on this page), `listAuditEvents` with normalized UTC filters.
- Known audit actions (from string literals in `apps/api/src`, read 2026-10-12): `org.created`, `invitation.create`, `invitation.created`, `invitation.accepted`, `invitation.revoked`, `member.left`, `member.removed`, `member.role_changed`, `project.create`, `project.created`, `sbom.upload_initiated`, `sbom.upload_completed`, `investigation.create`, `investigation.created`. The implementer re-greps `apps/api/src` for audit action literals and keeps the constant in sync; the datalist only suggests, it never restricts.
- API, event, and storage contracts: none changed. **Verified (code read of `apps/api/src/audits.ts`):** `from`/`to` must match `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$`; `from >= to`, a non-UUID `actorId`, an empty or >100-char `action`, or a bad `result` return 400 `invalid_input`; cursors are bound to the filters. **Verified (code read of `apps/web/src/lib/api.ts`):** failed results expose `status`, `correlationId` and the problem `code`.
- Selector compatibility contract. These stay exactly as they are:
  - Test IDs: `org-name`, `org-slug`, `org-role`, `project-list`, `no-projects`, `project-form-error`, `api-unavailable`, `members`, `member-row` (+ `data-user-id`), `member-role`, `members-error`, `invitations`, `invitation-row`, `invite-error`, `invite-link-box`, `invite-link`, `audit-events`, `no-audit-events`; `project-name` on the project page is untouched.
  - Accessible names: links "Members" (sidebar), "Audit history", "More audit events", "More projects", "More members", project links by name; buttons "Create project", "Change role", "Remove", "Leave", "Revoke", "Invite", "Filter", "Sign out" (exactly one per page); labels "Project name", "Project slug", "Email", "Invitation role", "Action", "Result"; column header "Email" (admins only); a `combobox` per member row (role select).
  - Text: `org-role` is `admin`/`member`; `member-role` is `admin`/`member`; `members-error` contains "at least one admin"; `audit-events` contains the action name (for example `org.created`); the audit `tbody tr` count equals the page size (no extra rows in the table body).
  - Intended e2e changes (only these): `projects.spec.ts` clicks "New project" before filling the form; `invitations.spec.ts` clicks "Invite member" before filling, and confirms "Revoke" in the dialog; `members.spec.ts` confirms "Remove" and "Leave" in the dialog. Because the row button and the dialog's confirm button share a name, specs scope the confirm click to the dialog (`getByRole("alertdialog")`).
- Compatibility and migration considerations: no data migration. The stacked PRs each keep the full e2e suite green. During PR1 the members and audit pages still render via `LegacyPage` (opted in per page).

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | Unknown; local/dev scale | No production traffic yet | N/A |
| Extra API calls | +1 `GET /v1/me` per audit page render; otherwise unchanged | Design | Code review; API request log while navigating |
| Data size | Unchanged page sizes (API defaults; audit default 50, max 100) | `apps/api/src/audits.ts` | N/A |
| Client bundle | Client components limited to dialogs, confirm wrapper, copy button, `LocalTime`, audit filter form; tables stay server components | Design | `next build` route sizes in each PR description |
| Latency target | No measurable regression beyond the extra `/v1/me` call on audit | Assumption | Manual comparison in dev; not gated |
| Availability | Every page renders its error state when any call fails; a failed `/v1/me` or invitations call never blocks the members or audit table | Requirement | e2e against the API-down dev server; unit tests of load helpers where extracted |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| API down entering any org page | Degraded shell (SENTRA-34) plus the page's `ErrorState` (`api-unavailable`, "Reference: <id>"); Sign out still present | `shell.spec.ts` degraded case extended; `audit-events.spec.ts` unavailable case |
| Project list fails, org lookup succeeds | Header renders; projects area shows `ErrorState` with reference; "New project" still available | Manual; unit test if extracted |
| Duplicate project slug | `project-form-error` "already taken" inside the dialog; dialog stays open; values kept | `projects.spec.ts` |
| Pending invitations fail to load | Inline `ErrorState` with reference in the invitations section; members table and "Invite member" still work | Manual (stop API mid-test is hard); component/unit test of the section state |
| Invite with invalid email / limit reached / forbidden | `invite-error` alert in the dialog with the existing messages; dialog stays open | Existing messages; manual |
| Invite success, user presses Esc or clicks outside | Dialog stays open while the link is shown; only "Done" closes it | e2e in `invitations.spec.ts` (Esc does not close) |
| Clipboard unavailable or denied | "Copy link" shows a failure status ("Copy failed, select the link"); link remains selectable | Manual; unit test of the status handling if extracted |
| Confirm dialog cancelled | Nothing submitted; row unchanged; focus returns to the row button | `members.spec.ts` cancel case |
| Remove/Leave/Revoke target already gone (concurrent change) | Existing behavior: `members-error` "no longer exists"; Leave on 404 redirects to `/` | Existing action logic; unchanged |
| Demoting the last admin | `members-error` "An organization needs at least one admin." | `members.spec.ts` |
| Non-admin opens `/members` | No Email column, no "Change role"/"Remove"/"Invite member", one "Leave"; no admin email in the body | `members.spec.ts` |
| Non-admin opens `/audit-events` | `EmptyState` "You do not have access to audit history."; no API call for events | Existing/added e2e assertion |
| Non-member or unknown org | `notFound()` from `fetchOrg` (unchanged), no shell data | `organizations.spec.ts`, tenant isolation tests |
| Audit From ≥ To, unparsable date, non-UUID actor ID, action > 100 chars | `audit-filter-error` alert, no API call, inputs keep values | Vitest for the parser; e2e for From ≥ To |
| Unparsable From/To (a hand-edited URL only; the control never produces one) | The value is dropped, so the input renders empty while the `audit-filter-error` alert names the field | Vitest for the parser |
| API returns 400 `invalid_input` for audit filters (for example a tampered cursor) | Same `audit-filter-error` alert, not `api-unavailable` | Unit test of the result mapping; e2e with a bad `cursor` query |
| Unknown action typed | Accepted; empty result shows `no-audit-events` | `audit-events.spec.ts` |
| No-JS audit filter submit | Bare `datetime-local` values treated as UTC, normalized, hint "Times in UTC"; table shows UTC times | e2e in a JS-disabled context |
| DST gap/overlap local times in filters | Browser `Date` resolves the wall-clock time; the resulting UTC value is shown in the tooltip and the URL | Vitest with fixed-zone cases (`TZ` set in the test, for example Europe/Amsterdam on DST change days) |
| Hydration | `LocalTime` server and first client render are identical (UTC text); local text applied in an effect | No hydration warnings in the browser console (manual); Playwright console check |
| No-JS project creation / invitations | Dialog cannot open; the triggers do nothing | Known limitation, documented |
| No-JS Remove/Leave/Revoke | Submits directly without confirmation (same as today) | Manual check in a JS-disabled context |
| Narrow viewport | Header actions wrap; Sign out is icon-only below `sm` with the name "Sign out"; members and invitations tables stack rows below `sm` (no horizontal scroll); dialogs fit the viewport | Manual + mobile screenshot |
| Very long names/emails | Truncate with `title` in tables and headers; dialogs wrap | Manual |

## Security, observability, and rollout

- Authorization and tenant isolation: unchanged. No new endpoint or route handler. Pages show only what the API returns for the user. UI hiding of admin controls is cosmetic; the API enforces roles (unchanged server actions re-check everything).
- Sign-out: posts to the existing `/auth/logout` (Origin-header CSRF guard unchanged).
- Invitation token: still returned only by the create action, shown once in the dialog, never logged, never stored in a cookie, URL or client storage. "Copy link" writes it to the clipboard only on an explicit click.
- Sensitive data: member emails still render only for admins. Audit actor IDs are internal UUIDs already shown today (now shortened, full value in `title`). The browser timezone is read client-side only and never sent to the server.
- Input handling: audit filter values are validated in the web and again by the API; they are encoded with `URLSearchParams` (unchanged `auditEventsQuery`).
- New dependencies: none beyond shadcn copy-in components using the installed `radix-ui`. Run `task security`.
- Logs, metrics, traces: no new server logic beyond the existing helpers; `callApi` failure logging with correlation IDs covers the error states. The 400-to-validation mapping does not add log lines.
- Rollout and rollback: ships with the web app; no flags, no migrations. Each stacked PR can be reverted on its own (in reverse order). Owner: apps/web.

## Acceptance criteria

PR1 (frame, Sign out, org page):

- [ ] `OrgFrame` no longer wraps org pages in `LegacyPage`; members and audit pages opt in temporarily; project routes unchanged.
- [ ] Every org and project route shows exactly one "Sign out" button in the shell header; it is a POST to `/auth/logout`, works without JS, and keeps its accessible name below `sm` (icon only).
- [ ] The org page shows the name (`org-name`, single `h1`), mono slug (`org-slug`), role badge (`org-role` text `admin`/`member`), and for admins an "Audit history" link.
- [ ] Projects render in a `DataTable` (`project-list`) with name links and mono slugs and "More projects" pagination; empty first page shows `no-projects`; failures show `api-unavailable` with a reference.
- [ ] "New project" opens a dialog with the existing form (slug suggestion, constraints, hint); errors show `project-form-error` in the dialog; success navigates to the project; the submit button is disabled with `aria-busy` while pending and keeps its name.

PR2 (members):

- [ ] Members render in a `DataTable` with the existing test IDs, "(you)" marker, admin-only Email column and role controls.
- [ ] Remove, Leave and Revoke open an `AlertDialog` naming the target and consequence; Cancel submits nothing and returns focus; without JS they submit directly.
- [ ] Admins see "Invite member", which opens a dialog (Email, Invitation role, Invite); errors show `invite-error`; success shows `invite-link-box`/`invite-link`, "Copy link" with an announced status, "Shown only once" and "Done"; Esc and outside-click do not close it while the link is shown.
- [ ] Pending invitations show in `invitations`/`invitation-row` with expiry (fixed UTC text in PR2; local time via `LocalTime` in PR3); a load failure shows an inline `ErrorState` with a reference while the members table still works.
- [ ] Non-admins see no Email column, no admin actions, no "Invite member", and one "Leave".

PR3 (audit events):

- [ ] Filters: From/To (`datetime-local`), Actor ID, Action (datalist of known actions, free text accepted), Result; the URL and API receive only strict UTC ISO values.
- [ ] Times display in local time with a short zone name and the exact UTC ISO in `title`; the server HTML shows UTC with a "UTC" label; no hydration mismatch warnings.
- [ ] Without JS, bare From/To values are treated as UTC, the hint says "Times in UTC", and filtering works.
- [ ] Invalid filters (From ≥ To, bad date, non-UUID actor, overlong action) and API 400 `invalid_input` show `audit-filter-error`, never `api-unavailable`.
- [ ] Result shows as a `StatusBadge` with a text label and the failure code; actors show a short mono ID with the full ID in `title` and "You" for the signed-in user.
- [ ] Non-admins see "You do not have access to audit history."; "More audit events" keeps the filters.

All PRs:

- [ ] All existing e2e specs pass with only the intended changes listed in the selector compatibility contract.
- [ ] axe reports no WCAG 2 A/AA violations on the org page, members (with the invite dialog and a confirm dialog open) and audit events, in light and dark.
- [ ] Screenshots (light, dark, mobile; dialogs open) committed under `docs/features/SENTRA-36-ui-org-pages/screenshots/` via `SENTRA_E2E_DOC_SCREENSHOTS=1` and linked with commit-SHA permalinks.
- [ ] `task fallow` passes with findings fixed, not suppressed; no generated `AGENTS.md`/`CLAUDE.md` committed.

## Implementation plan

Before step 1, run `senior-ux-design-engineer` with this spec (Refero references for org overview, members management with invite dialog, audit log with filters; existing design system). Fold its recommendations into this spec, or flag scope changes to the user.

PR1: `feature/SENTRA-36-ui-org-pages` (frame, Sign out, org page)

1. Frame. `OrgFrame` renders a design-system column; members and audit pages wrap their bodies in `LegacyPage`. Expected: visuals of members/audit unchanged; e2e green. Tests: existing suite.
2. Sign out in the shell. Extract a shared `SignOutButton` (or equivalent) used by `CenteredLayout` and `ShellHeader`; icon-only below `sm` with `sr-only` text. Depends on 1. Expected: one "Sign out" per page in both frames. Tests: add to `shell.spec.ts` (sign out from an org page reaches the sign-in flow; exactly one button on an org and a project route); `sign-in.spec.ts` and `entry-onboarding.spec.ts` unchanged.
3. Add shadcn `dialog` via the CLI (fix the `cn` quirk; prune unused exports). Expected: compiles, fallow clean once used in step 4.
4. Org page rebuild with the "New project" dialog (header action and empty-state action, distinct names). `PageHeader` gains a minimal way to set the title test ID if needed. Depends on 3. Expected: acceptance criteria PR1. Tests: update `projects.spec.ts` (open dialog first); dialog keeps open on `project-form-error`; axe case for the org page with the dialog open (light, dark); screenshots.
5. PR1 notes in this spec (deviations, verified assumptions).

PR2: branched from PR1 (members)

6. Add shadcn `alert-dialog`; build `ConfirmSubmit` (submit button that, once hydrated, prevents the native submit and opens the dialog; confirm calls `form.requestSubmit()` or submits the same form). Verify the no-JS fallback in a JS-disabled context. Tests: e2e cancel and confirm; no-JS manual check recorded here.
7. Members table rebuild with `DataTable`, role controls, Remove/Leave confirms, `members-error` alert. Depends on 6. Tests: update `members.spec.ts` (confirm in dialog; add a cancel case).
8. Invitations: "Invite member" dialog with the success state (locked dismissal, Copy link with live status), pending invitations table with `LocalTime` expiry (introduce the `LocalTime` component and its formatting helpers here), Revoke confirm, inline `ErrorState` on load failure. Tests: Vitest for the local-time formatting helpers; update `invitations.spec.ts` (open dialog; Esc does not close while the link shows; confirm Revoke); axe with the invite dialog and a confirm dialog open; screenshots.
9. Remove the members page's `LegacyPage` opt-in. PR2 notes in this spec.

PR3: branched from PR2 (audit events)

10. Pure helpers: `audit-filters.ts` (parse, validate, normalize bare values to UTC, next-page query), `audit-actions.ts` (known actions, re-grepped from `apps/api/src`), local-input conversions in `local-time.ts`, actor display helper. Tests: Vitest including DST-boundary cases under a fixed `TZ`, bare-value normalization, From ≥ To, non-UUID actor, overlong action, cursor preservation.
11. Audit page rebuild: client filter form (datetime-local with UTC conversion on submit and local prefill from the URL, datalist, timezone hint), `audit-filter-error` handling (including API 400), `DataTable` with `LocalTime`, `StatusBadge` mapping for `success`/`failed`, actor display with "You" from `/v1/me`, non-admin `EmptyState`. Remove the `LegacyPage` opt-in; `OrgFrame` no longer imports it. Depends on 10. Tests: update `audit-events.spec.ts` (existing flows; From ≥ To shows the alert; a bad cursor shows the alert, not `api-unavailable`; JS-disabled filter submit); axe light/dark; screenshots.
12. Learning note `docs/learning/SENTRA-36-ui-org-pages.md` (UTC storage vs local display, hydration-safe client formatting, progressive enhancement with dialogs and confirms, one-time secrets in UI). Final spec update: status, verified assumptions, deviations. Record follow-ups 1–4 in YouTrack.

## Verification

- Manual checks and expected results:
  - Sign out from an org page and from a project page: session ends and the identity provider signs out (as on `/`).
  - Create a project from the dialog; duplicate slug keeps the dialog open with the error.
  - Invite someone: success state shows the link; Esc and outside-click do not close it; Copy link copies and announces; Done closes and the pending list shows the invitation; Revoke asks for confirmation.
  - Remove a member, cancel then confirm; Leave as a member lands on `/`.
  - Audit: filter by a local From/To range, check the URL holds UTC ISO values and the table times match the tooltip UTC; From ≥ To shows the validation alert; type an unknown action and get the empty state.
  - Disable JavaScript: Sign out works; audit filters work with UTC semantics and the "Times in UTC" hint; Remove/Leave/Revoke submit directly; "New project" and "Invite member" do nothing (Known limitation).
  - Stop the API: each page shows its `ErrorState` with a reference inside the degraded shell.
  - Narrow viewport: icon-only Sign out, dialogs fit, tables scroll.
  - Browser console: no hydration warnings on audit and members.
- Automated tests and what they prove:
  - Vitest: time formatting and local/UTC conversions (including DST), audit filter parsing and validation, bare-value normalization, next-page query keeps filters, actor display, known-actions constant shape.
  - Playwright: existing specs with only the contracted changes (no regressions); new cases for Sign out in the shell, confirm cancel, invite dialog locked dismissal, audit validation alert and bad-cursor handling, no-JS audit filtering; axe in light and dark with dialogs open.
- Load or failure tests: N/A beyond the API-down e2e cases.

## Definition of done

- `task lint`, `task format:check`, `task typecheck`, `task test`, `task web:test:e2e` (with `task stack:up` and `task stack:bootstrap`), `task security` and `task fallow` pass on each PR; fallow findings fixed, not suppressed.
- No generated `AGENTS.md`/`CLAUDE.md` committed; explicit paths staged.
- Screenshots committed and linked with commit-SHA permalinks in each PR; PRs use `.github/pull_request_template.md` and link this spec and the YouTrack story URL.
- This spec updated with verified assumptions and deviations; learning note added in PR3; follow-ups recorded in YouTrack; SENTRA-36 updated with acceptance criteria and the spec link.

## Known limitations

1. Without JavaScript, project creation is unavailable (the dialog cannot open). Follow-up 4 if it matters.
2. Without JavaScript, admins cannot invite (same reason).
3. Without JavaScript, Remove, Leave and Revoke submit without confirmation (same as before this story).
4. Audit and invitation times render in UTC first and switch to local time after hydration; without JavaScript they stay in labelled UTC.
5. Audit actors show as short IDs, not names (follow-up 1).
6. The datalist suggestion UI differs between browsers.
7. Shell data staleness and no-JS mobile navigation limits from SENTRA-34 remain.

## Open questions and assumptions to validate

- **Assumed:** a Radix `AlertDialog` can be driven from a native submit button so that, once hydrated, the click opens the dialog (native submit prevented) and the confirm submits the same server-action form, while without JS the button submits directly. Validate in step 6 with a JS-disabled Playwright context and record the result here.
- **Assumed:** Radix `Dialog` in `radix-ui` 1.7.0 lets the content block dismissal conditionally via `onEscapeKeyDown` and `onInteractOutside` (`event.preventDefault()`). Check with context7 before step 8 and verify with the e2e Esc case.
- **Assumed:** a `datetime-local` field submitted without JS sends `YYYY-MM-DDTHH:mm` (no seconds unless `step` allows them, no zone). Validate in step 11 with a JS-disabled context.
- **Assumed:** `Intl.DateTimeFormat` with `timeZoneName: "short"` yields a usable abbreviation (for example `CEST`) in supported browsers and falls back to an offset form (`GMT+2`) where none exists; both are acceptable labels. Validate in step 8 unit tests (Node ICU) and manually in Chromium.
- **Assumed:** `new Date("YYYY-MM-DDTHH:mm")` (no zone) is parsed as local time by browsers (ECMAScript date-time form without offset), which the client conversion relies on. Validate in step 10 unit tests under a fixed `TZ`.
- **Verified (code read):** API audit filter formats and 400 behavior (`apps/api/src/audits.ts`); `ApiResult` exposes `code` (`apps/web/src/lib/api.ts`); the web `Project` type has only `id`, `name`, `slug` (`apps/web/src/lib/projects.ts`); `StatusBadge` has no `success` status, so `success` maps to the existing `succeeded` variant and its fixed label "Succeeded" (no badge change) (`apps/web/src/components/status-badge.tsx`).
- **Verified (SENTRA-34/35):** the shadcn CLI `cn` dependency quirk and the `screenshotPath` helper behavior.

## UX recommendations (research pass, 2026-10-12)

Sources: Refero (invite dialogs, remove confirms, audit logs, members tables), the existing design system, Radix docs via context7. Assumptions below are **Assumed** until the implementer checks them in a real browser.

### Cross-cutting
- Dialog content: `max-w-md w-[calc(100vw-2rem)] max-h-[calc(100svh-2rem)] overflow-y-auto`; autofocus first field; `motion-reduce:` variants on animations.
- Use the native `<select>` (Input tokens) for invite role, member role and audit Result. Do not add shadcn `select`.
- Destructive confirm: `variant="destructive"`; Cancel `outline` and focused by default (Radix default).
- Row buttons: `outline`, `xs` or `sm`, target >= 24px (WCAG 2.2 AA 2.5.8).
- No `text-transform` on `org-role` / `member-role`; show lowercase `admin` / `member` in a `Badge variant="outline"`.
- Long values: `max-w-[28ch] truncate` + `title`; mono for slugs, IDs, actions, links; `tabular-nums whitespace-nowrap` for times.

### Sign out
- One shared `SignOutButton`: POST form to `/auth/logout`, `Button ghost sm`, `LogOut` icon (aria-hidden), label `sr-only sm:not-sr-only`, in the `ml-auto` group next to the theme toggle. Also used by `CenteredLayout` (adds an icon on SENTRA-35 pages; accessible name unchanged; note in PR). Check breadcrumb truncation at 320px.

### Org page
- `PageHeader`: add `titleTestId` (or accept a ReactNode title). Description slot is inside a `<p>`: inline elements only (mono slug + role Badge). Actions wrapper gets `flex-wrap`.
- Actions: "Audit history" (outline, admins only), then "New project" (the only primary).
- Projects DataTable: Name (link, truncated), Slug (mono, muted). No extra columns.
- Empty state: "This organization has no projects yet." / "Projects hold the SBOMs and findings for one application." / action "Create your first project" (opens the same dialog; name differs from the header trigger).
- New project dialog: description "Pick a name. The slug is used in URLs and cannot be changed later."; slug hint via `aria-describedby`; `project-form-error` is `role="alert"` above the footer; dialog stays open on error, values kept; duplicate slug sets `aria-invalid`; remount content on open to reset state.

### Members
- Columns: Name ("(you)" muted), Email (admins only), Role, Actions (`sr-only` header text). No "Joined" column.
- `members-error` via existing `ErrorState` (`testId="members-error"`). Alert-at-load announcement is inconsistent in screen readers: advisory only.
- Confirm copy: Remove "Remove Jane?" / "Jane will lose access to Acme immediately. You can invite them again."; Leave "Leave Acme?" / "You will lose access immediately and need a new invitation to return."; Revoke "Revoke invitation for jane@example.com?" / "The invitation link stops working. You can send a new invitation." Null name falls back to email (admins) or "this member".
- ConfirmSubmit: do NOT use `AlertDialog.Trigger` (renders `type="button"`, breaks no-JS submit). Use a plain `<button type="submit">` whose `onClick` calls `preventDefault()` and sets controlled `open`; restore focus in `onCloseAutoFocus` via ref. The confirm button is portaled outside the form: call `formRef.current.requestSubmit()` (or `form={id}`). e2e scopes the confirm click to `getByRole("alertdialog")`. **Assumed**, verify in PR2 incl. a JS-disabled context.
- Invite dialog: Email, "Invitation role" native select (helper line only if wording is confirmed against the API), Cancel + "Invite". Success state: heading "Invitation sent to <email>" (`tabIndex={-1}`, focused, in `role="status"`), `invite-link` mono `break-all select-all`, "Copy link" with separate `aria-live="polite"` status, "Shown only once. Copy it now, or revoke and re-invite later.", "Done" only. Locked: `onEscapeKeyDown`, `onPointerDownOutside`, `onInteractOutside` call `preventDefault()` and the top-right X is hidden while the link shows. Token must not be stashed in a ref, context or storage. Pending: disabled + `aria-busy`, constant label.
- Pending invitations: `h2` "Pending invitations", columns Email, Role, Expires (`LocalTime`), Revoke; hidden when empty. Load failure: `ErrorState` "Could not load pending invitations" / "Members are unaffected. Try again shortly." + reference.

### Audit events
- `FilterBar` is a server component: the client filter form renders its own `<form method="get">` with a shared class constant exported from `filter-bar.tsx`. Fields: From, To (`w-52`), Actor ID (`w-80`, mono), Action (`w-56`), Result, "Filter".
- **Correction to the design:** `datetime-local` needs `step="1"` (or `noValidate`), otherwise a prefilled value with non-zero seconds triggers native `stepMismatch` and silently blocks submit. Test prefill from a URL with seconds.
- Timezone hint: `text-xs text-muted-foreground`, `aria-describedby` on From/To, reserve line height so the hydration swap does not shift layout.
- Validation: per-field `{ field, message }[]`; one alert above the table (`audit-filter-error`, `role="alert"`, "Check the filters"); `aria-invalid` + `aria-describedby` on offending inputs. Copy: "From must be earlier than To."; "Enter a valid date and time for From." (same for To); "Actor ID must be a UUID, for example 3f2b8c1e-..."; "Action must be 1 to 100 characters."; API 400 / bad cursor: "The service rejected these filters. Apply the filters again or clear them." Do not echo user input.
- Columns: Time (`LocalTime`), Action (mono), Result (`StatusBadge` + failure code in `<code>` when failed), Actor ("You" or 8-char mono short ID, full ID in `title`), Target (type muted + short mono ID, optional). Verify the Table container scrolls horizontally on small screens.
- Forbidden: title "You do not have access to audit history." + separate description "Only organization admins can view it."
- Known limitation: `title` tooltips (UTC ISO) are not keyboard/touch reachable.

### Test hygiene
- `getByLabel` is a case-insensitive substring match ("Actor ID" contains "to"): use `{ exact: true }` for From, To, Email, Action, Result in new specs; use `exact: true` for the invite submit ("Invite" vs "Invite member").
- Run axe at 320px with Sign out visible and with a dialog open in dark mode.

### Decided
- Audit events get a "Clear filters" link (plain link to the bare audit URL, shown only when a filter is active). Approved by the user 2026-10-12; added to PR3 scope.

## PR1 implementation notes (2026-10-12)

- **Verified:** `shadcn add dialog` adds a bogus `cn` npm dependency (v0.4.0) and imports from it; reverted `package.json`/lockfile and imported `cn` from `@/lib/utils`. Unused exports (`DialogOverlay`, `DialogPortal`) and the `showCloseButton` footer variant were pruned.
- **Verified (axe):** axe run while a dialog is fading in reports contrast 1.04 on its text (mid-animation opacity). The axe case waits for the dialog's animations to finish before scanning.
- `SignOutButton` (`components/shell/sign-out-button.tsx`) is shared by `CenteredLayout` and `ShellHeader`; SENTRA-35 pages now show a `LogOut` icon too (name unchanged).
- `PageHeader` gained `titleTestId`; its actions wrapper now wraps (`flex-wrap`).
- Members and audit pages wrap their bodies in `LegacyPage` (replacing their root `<main>`, since the shell already renders `<main>`) until PR2/PR3.
- Other e2e specs that created a project through the org page gained one "New project" click.
- Duplicate-slug error: the dialog stays open with values kept; `aria-invalid` on the slug input was not added (the action returns one error string, not a field).
- The root breadcrumb ("Organizations") is hidden below `sm` on trails with more than 2 crumbs, so org and project names stay legible (UX agent change, not previously in the spec).

## PR2 implementation notes (2026-10-12)

- **Verified:** `shadcn add alert-dialog` again adds a bogus `cn` dependency and imports from it, and also stops on an overwrite prompt for `button.tsx` (answer no). Reverted `package.json`/lockfile, imported `cn` from `@/lib/utils`, and pruned the file to the pieces used (Root, Content with overlay and portal, Header, Footer, Title, Description, Action, Cancel).
- **Verified (Chromium e2e and a JS-disabled context):** `ConfirmSubmit` works as assumed. A plain `type="submit"` button whose `onClick` calls `preventDefault()` and opens a controlled `AlertDialog`; the confirm calls `button.form.requestSubmit()` (the button's own form, so no `formRef` or `form=` id is needed). Focus returns to the row button through `onCloseAutoFocus` (asserted after Cancel). With JavaScript disabled the Remove button submits the server-action form directly and no dialog appears (`members.spec.ts`, no-JS case, using the signed-in `storageState`).
- **Verified:** Radix `Dialog` blocks dismissal through `onEscapeKeyDown`, `onPointerDownOutside` and `onInteractOutside` calling `preventDefault()`; with `showCloseButton={false}` while the link shows, Esc and a click outside leave it open (`invitations.spec.ts`). Closing unmounts the dialog content, so the one-time link is dropped from React state on Done; focus returns to "Invite member".
- `InviteState` gained `email` so the success heading can read "Invitation sent to <email>" (return shape only; the API call is unchanged). The heading is the `DialogTitle` itself, focused on mount, rather than a separate `role="status"` wrapper; the Copy link status is its own `aria-live="polite"` region, always rendered.
- Pending-invitation expiry renders a fixed `YYYY-MM-DD HH:mm UTC` text in a `<time dateTime>`; `LocalTime` and its helpers were deferred to PR3 as agreed (not introduced in PR2, so step 8's Vitest for time helpers moves to PR3).
- New shared pieces: `ui/native-select.tsx` (styled native select, reused by the audit Result filter in PR3), `dialog-form-footer.tsx` (Cancel plus a pending-aware submit, now also used by the project dialog to remove a fallow duplicate), `copy-button.tsx`, `confirm-submit.tsx`. `DataTable` gained `rowProps` (extra `data-*` attributes per row, for `member-row`/`data-user-id`) and a small `DataRow` extraction.
- `members-error` is the shared `ErrorState` (`role="alert"`) with the title "That did not work" and the unchanged messages. A pending-invitations load failure renders `ErrorState` (`invitations-error`, with the reference) and leaves the members table intact.
- axe (light and dark): the invite form dialog, the success dialog, the populated page and the Revoke confirm dialog at 320px, each scanned after the dialog animation finishes.
- Not verified here: `e2e/sbom-upload.spec.ts` fails in this environment (SBOM stays "Processing", the data pipeline consumer is not running); it does not touch the members code. The pending-invitations `ErrorState` is not exercised by e2e (the API cannot be failed selectively), and the Clipboard failure status is untested.

### PR2 UX verification changes (2026-10-12)

- **Verified (Chromium, 320/390/desktop, light/dark):** below `sm` the members and pending-invitations tables were 948px wide inside a scroll container, so Role and the row actions were off-screen. `DataTable` gained an opt-in `stackedRow` layout (each row becomes a small grid, header kept for screen readers only); members and invitations use it. Tradeoff: `display: grid` on rows can drop table semantics in some screen readers below `sm`.
- **Verified:** dialog content overflowed horizontally at 320px with a long email (success heading, link, Done). Dialog and AlertDialog content now use `grid-cols-[minmax(0,1fr)]`, and long titles wrap anywhere.
- **Verified:** destructive confirm contrast (white text) is 6.64:1 light and 6.43:1 dark (sampled from screenshots). The stale `?error=` banner behind the Remove-confirm screenshot came from the e2e reloading after the last-admin attempt; it now opens the bare URL.
- The pending-invitations `ErrorState` was verified visually by renaming the `invitations` table for a moment (members still render, no overflow); it is still not covered by e2e.
- UX agent changes (mobile polish): `DataTable` gained an optional `stackedRow` prop (grid template classes) that turns each row into a small grid below `sm` with a screen-reader-only header, used by the members and invitations tables; `Dialog`/`AlertDialog` content got `grid-cols-[minmax(0,1fr)]` so long emails and links wrap instead of widening the dialog; pending-invitation expiry wraps. To keep fallow green `DataTable` was split into `HeaderRow`, `DataRow` and `LoadMore` (no behavior or test-ID change).

## PR3 implementation notes (2026-10-13)

- **Verified (Chromium):** the `datetime-local` `stepMismatch` claim is true in one situation. A field whose `value` attribute is `...:00` and whose value is later set from script to a value with seconds reports `stepMismatch: true` (the attribute is the step base), as does a field with no `value` attribute given non-zero seconds. With `step="1"` it is `false` in both. A value prefilled only through the markup (the no-JS path) never mismatches, because the attribute becomes the step base. The form uses `step={1}` on From and To; an e2e fills seconds (`10:00:05`) and submits.
- **Verified (Playwright/Chromium):** a no-JS `datetime-local` submits `YYYY-MM-DDTHH:mm` (no zone, no seconds); the no-JS e2e asserts `from=2026-01-15T10%3A00`, the "Times in UTC" hint and UTC table times. Also: Playwright `fill("...T00:00:00")` fails with "Malformed value" because Chromium normalizes zero seconds away; the specs fill minutes only unless seconds are non-zero.
- **Verified (Vitest, `TZ=Europe/Amsterdam` set in `beforeAll`):** `new Date("YYYY-MM-DDTHH:mm")` is read as local time; `Intl` `timeZoneName: "short"` gives `CET`/`CEST` (the test also accepts `GMT+1`/`GMT+2`; Chromium in the e2e showed `GMT+2` for `en-CA`). Spring-forward gap (`02:30` on 2026-03-29) resolves to `01:30Z`; fall-back overlap (`02:30` on 2026-10-25) resolves to the first occurrence (`00:30Z`).
- **Verified (code read of `apps/api/src/org-input.ts`):** the API's UUID pattern is lowercase only, so the web trims and lowercases the actor ID before validating and sending it (an uppercase UUID would otherwise 400).
- Known audit actions re-grepped from `apps/api/src`: the spec's 14 are unchanged. `investigation.requested`, `sbom.uploaded` are Kafka event types, not audit actions, and are not in the list.
- `LocalTime` uses `useEffect` as specified. It is used for audit Time and now for the pending-invitation expiry on the members page (`YYYY-MM-DD HH:mm:ss UTC` before hydration, so the fixed text gained seconds).
- New pure modules: `lib/local-time.ts` (`formatUtc`, `formatLocal`, `toLocalInputValue`, `fromLocalInputValue`), `lib/audit-filters.ts` (`parseAuditFilters`, `normalizeInstant`, `hasActiveFilters`, `rawAuditQuery`, issue ids), `lib/audit-actions.ts`, `lib/me.ts` (`fetchMe`, now also used by the members page), and `actorLabel`/`shortId`/`isRejectedFilters` in `lib/audits.ts`. `rawAuditQuery` reduces a repeated parameter (an array in `searchParams`) to its first value so user input cannot crash the page.
- The audit filter form submit uses `router.push` with a UTC-converted query, because a `datetime-local` input cannot hold a `Z` value. The form is remounted by `key` when the normalized filters change (Clear filters, pagination) so its state follows the URL. The hint line is `min-h-4` so the swap does not shift layout. `FILTER_BAR_CLASS` is exported from `filter-bar.tsx`. Constants used by server code (`FILTER_ERROR_ID`, `issueId`) live in `lib/audit-filters.ts`: exported non-components from a `"use client"` file arrive as references on the server (first attempt caused a 500 on the invalid-filter page).
- `ErrorState` gained optional `children` (the per-field issue list). Field errors link to inputs with `aria-invalid` and `aria-describedby`; From >= To is attached to the To field.
- Widths: From/To are `sm:w-64` (the spec's `w-52` clipped the seconds and AM/PM of the native control in Chromium).
- The forbidden state shows the page header, the title "You do not have access to audit history." and the description "Only organization admins can view it."
- e2e: `audit-events.spec.ts` (exact labels; "You" marker; local filter with UTC URL, local prefill, hint and Clear filters, no hydration console errors; From >= To plus bad actor alert; bad cursor alert not `api-unavailable`; no-JS filtering and server-side From >= To; non-admin forbidden state), axe on the audit page (light/dark, plus the alert at 320px). `psql`, `seedMember`, `signedInUserId` and `newSession` moved from `members.spec.ts` to `helpers.ts` for reuse. Screenshots: `audit-filtered.png`, `audit-invalid.png`, `audit-invalid-m390.png`.
- Not verified: `e2e/sbom-upload.spec.ts` still fails in this environment (pipeline consumer not running; unrelated). Dark-theme and mobile screenshots of the filtered table were not captured (axe covers dark); the Clipboard failure status and the pending-invitations `ErrorState` remain untested by e2e. Follow-ups 1-4 still need recording in YouTrack (not done here).

### PR3 review fixes (2026-10-13)

- The filter form is no longer remounted by `key` (it lost keyboard focus after every submit). All fields are controlled and follow the URL through an effect; after a submit with issues, focus moves to the first offending field (e2e asserts it). The Actor cell uses `actorLabel` only.

### Decided: audit "To" is exclusive (2026-10-13)

The API treats `to` as exclusive (`created_at < to`) and the UI has second precision, so an event at 10:00:05.5 is excluded by To = 10:00:05. The user chose to keep the half-open range and document it; no code change.
