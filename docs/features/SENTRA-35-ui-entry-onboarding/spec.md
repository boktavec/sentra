# SENTRA-35: Revamp entry and onboarding pages

- Status: Implemented, reviewed (PASS WITH ADVISORIES), awaiting PR
- YouTrack: [SENTRA-35](http://localhost:8080/issue/SENTRA-35)
- Owner: apps/web
- Depends on: [SENTRA-34](http://localhost:8080/issue/SENTRA-34) (UI foundation, merged) — see [`docs/features/SENTRA-34-ui-foundation/spec.md`](../SENTRA-34-ui-foundation/spec.md)
- Branch / worktree: `feature/SENTRA-35-ui-entry-onboarding` at `sentra-worktrees/SENTRA-35-ui-entry-onboarding`

## Problem and outcome

`/`, `/orgs/new` and `/invitations/accept` already render inside `CenteredLayout` (wordmark and theme toggle, from SENTRA-34). Their bodies are still unstyled legacy markup wrapped in `LegacyPage` (`[data-legacy]`). These are the first screens every user sees: after sign-in, when creating a first organization, and when joining one by invitation. Right now they look like debug pages. The raw user UUID appears as body text on `/`, and the only sign-out control is a bare button in the body of `/`.

Done means:

- The three pages are rebuilt with the SENTRA-34 design system (tokens, `PageHeader`, `EmptyState`, `ErrorState`, `Button`, plus shadcn `Card`, `Input` and `Label`). They no longer use `LegacyPage`, and they meet WCAG 2 A/AA in light and dark.
- `/` is a clear org picker with a first-run empty state and an error state.
- `/orgs/new` is a card form with a live URL preview of the slug.
- `/invitations/accept` is a card with clear copy, including explicit recovery steps when the email does not match.
- "Sign out" is a visible header control on all three pages. The user ID is demoted to a muted "Support ID" footer line on `/`.
- Running the e2e suite no longer rewrites screenshots committed under earlier stories' `docs/features/*/screenshots/`.

## Scope

- In scope:
  - Rebuilding the page bodies of `/`, `/orgs/new` and `/invitations/accept` (including `new-org-form.tsx` and `accept-form.tsx`).
  - `CenteredLayout`: a "Sign out" button (POST form to `/auth/logout`) in the header; the three pages stop using `LegacyPage`.
  - Adding shadcn `card`, `input` and `label` through the shadcn CLI.
  - UX improvements inside `apps/web` only: the org list layout, the first-run empty state, the slug URL preview, pending-state feedback, clearer copy for invitation errors, and the "Support ID" footer.
  - An e2e screenshot path helper. By default it writes to a gitignored folder; an opt-in env var writes into the docs folders. All 12 specs that take screenshots switch to it.
  - axe coverage for the three pages in light and dark, and an e2e check of `/` with the API down.
- Out of scope (non-goals):
  - Any API, session, OIDC or `/auth/*` route change.
  - Auto-redirect from `/` to an org (one org, or last used).
  - An invitation preview (org name, role, inviter or expiry before accepting).
  - "Sign out and switch account" with a return to the invitation.
  - Sign-out or an account menu inside the org shell.
  - Showing the user's email or display name anywhere.
  - Per-field API validation errors on `/orgs/new` (the API returns only a status code).
  - Org pages, project pages and findings pages (SENTRA-36 to 38).
- Follow-ups (to record; see [Follow-ups](#follow-ups)): invitation preview endpoint; sign out and switch account with return to the invitation; sign-out in the org shell (SENTRA-36); account email display.
- Dependencies and related stories: SENTRA-34 (done). SENTRA-36 owns the follow-up for sign-out in the org shell.

## Decisions and alternatives

| Decision                          | Chosen approach                                                                                                                                                                                                                                     | Alternatives considered                                                                                                                               | Reason and tradeoff                                                                                                                                                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Story depth                       | Visual rebuild plus UX improvements in `apps/web` only, with no API change                                                                                                                                                                          | Visual-only rebuild; rebuild plus API changes (invitation preview, role in `GET /v1/orgs`)                                                            | Real UX gains without crossing a security boundary. An invitation preview needs a token-lookup endpoint (probing, rate limits, what to reveal on email mismatch) and deserves its own story.                                                                                             |
| Behavior of `/`                   | Always show the org picker; never redirect                                                                                                                                                                                                          | Redirect when the user has exactly one org; redirect to the last-used org (cookie)                                                                    | Predictable, no new state, and it keeps the shell's "All organizations" link (which points to `/`) meaningful. Both `sign-in.spec.ts` and `organizations.spec.ts` depend on landing on `/`. Cost: one extra click for users with a single org.                                           |
| Placement of the account controls | A visible "Sign out" button in the `CenteredLayout` header only. Sign-out in the org shell becomes a follow-up owned by SENTRA-36.                                                                                                                  | Header controls only, with no follow-up; a shared `AccountMenu` dropdown in both the centered layout and the org shell                                | Stays within the entry/onboarding scope and keeps `sign-in.spec.ts` unchanged (a dropdown would hide "Sign out" behind a trigger). The missing sign-out inside orgs is tracked explicitly instead of left as a silent gap.                                                               |
| User ID display                   | The user ID appears only as a muted "Support ID" footer line on `/`, under test ID `user-id`. No `/v1/me` call is added on other pages.                                                                                                             | User ID in the header (only on `/`, or with `/v1/me` fetched by `CenteredLayout` on every page)                                                       | A UUID does not help a user recognize their account. Its real purpose is support and diagnostics. `GET /v1/me` returns only `{ id }`, and the session stores no email, so a real identity display needs a follow-up.                                                                     |
| Recovery from email mismatch      | Clearer copy only. The message tells the user to sign out (header button), sign in with the invited address, and open the invitation link from the email again.                                                                                     | A "Sign out and switch account" button that returns to the invitation after sign-in (`returnTo` on `/auth/logout` plus the `sentra_return_to` cookie) | The `returnTo` design changes a security-sensitive auth route (open-redirect guard, keeping the cookie through provider logout, invitation token held in a cookie). It belongs with the invitation preview follow-up, which handles the same token.                                      |
| E2E screenshots                   | A shared helper in `e2e/helpers.ts` writes to `apps/web/test-results/screenshots/<feature>/` (gitignored) by default. Setting `SENTRA_E2E_DOC_SCREENSHOTS=1` writes into `docs/features/<feature>/screenshots/` instead. All 12 specs switch to it. | Keep the current paths and restore the PNGs after each run; commit the regenerated PNGs into the earlier stories' folders                             | Restyling these pages changes the screenshots in the SENTRA-1, SENTRA-2 and SENTRA-29 folders on every run, and SENTRA-36 to 38 would do the same to more folders. One mechanical fix keeps working trees clean and the historical records frozen.                                       |
| New components                    | shadcn `card`, `input` and `label` via the shadcn CLI; reuse `PageHeader`, `EmptyState`, `ErrorState` and `Button`                                                                                                                                  | Hand-written inputs and cards                                                                                                                         | Consistent with SENTRA-34. Known CLI quirk (SENTRA-34, **Verified** there): `shadcn add` adds a bogus `cn` npm dependency and imports `cn` from it. Revert the dependency and import `cn` from `@/lib/utils`. Remove `"use client"` if it is added to a component that does not need it. |
| Pending state on buttons | Disabled with `aria-busy="true"` and a spinner icon (`aria-hidden`) while pending. The label text never changes, so the visible text always matches the accessible name ("Create organization", "Accept invitation") | Change the button text ("Creating...") and pin the name with `aria-label` | Review finding R2: changing the text while pinning `aria-label` breaks WCAG 2.5.3 (label in name) during the pending state. A constant label also keeps e2e locators stable. |
| PR shape                          | A single PR. Commit 1 is the screenshot helper; then one commit per page.                                                                                                                                                                           | Stacked PRs (helper, then pages)                                                                                                                      | The story is small, and the helper is motivated directly by this story's visual changes.                                                                                                                                                                                                 |
| ADR                               | Not required                                                                                                                                                                                                                                        | —                                                                                                                                                     | The choices are local to `apps/web` and reversible.                                                                                                                                                                                                                                      |

## UX research

Refero was searched for two patterns; both confirm the approved design and none changes scope.

- **Organization picker / workspace list** (Factory workspace selection, Dock spaces empty state): a single centered column and a short list with one primary create action, and a plain "none yet, create one" empty state. Adopted: a bordered list in one card, create action in the page header, empty state that names both ways in (create or accept an invitation). Avoided: tabs, search and radio selection (a user has a handful of orgs; a link per row is faster).
- **Create workspace with slug** (Dub onboarding, Linear create workspace): name then URL, with a visible URL prefix, and a "Log out" escape at the top of the page. Adopted: Name/Slug stack, the `/orgs/<slug>` preview under the slug field, a visible Sign out in the header (as Linear does). Avoided: a split prefix input (it complicates the "Slug" label and `getByLabel`) and decorative gradients.

Recommendations that refine, not change, the spec (all implemented):

1. The slug preview shows `/orgs/<slug>` as a placeholder while the field is empty, so the preview area does not shift. It is a pure helper (`orgPathPreview`, Vitest-covered) and is wired into `aria-describedby` on the slug input, so screen readers hear it with the hint.
2. `Card` titles are not headings in stock shadcn (`div`). The page titles use `role="heading" aria-level={1}` so each page has exactly one `h1`.
3. Pending buttons keep a fixed `aria-label` while the text changes, as the spec decided.
4. List rows are whole-row links with `title` set to the full name; name and slug truncate. The mobile screenshot shows it.

No scope-changing finding.

## Implementation notes and verified assumptions

- **Verified** (JS-disabled browser context, signed in): the three forms and Sign out work without JavaScript; the org was created with a typed slug, listed on `/`, and Sign out reached the identity provider. The slug suggestion and preview need JS, as designed.
- **Verified**: `page.screenshot({ path })` creates missing folders (screenshot helper already in place).
- **Verified**: with `SENTRA_E2E_DOC_SCREENSHOTS` unset, a full e2e run leaves `git status` clean under `docs/`.
- `entry-onboarding.spec.ts` is a new spec that drives the three pages and writes this story's screenshots (with the env var set).
- The `signed-in` test ID is kept on the Support ID line.
- `LegacyPage` and the `[data-legacy]` CSS stay: org and project layouts still use them.
- shadcn `add` again added the bogus `cn` dependency; it was reverted and `cn` is imported from `@/lib/utils`. Unused exports `CardAction` and `CardFooter` were removed.

## Architecture and contracts

- Affected components: `apps/web` only.
  - `src/components/shell/centered-layout.tsx`: the header gains a POST form `action="/auth/logout"` with a `Button` named "Sign out". The children are rendered in a centered content column (for example `mx-auto w-full max-w-md` for form pages and `max-w-2xl` for `/`, or a `width` prop) instead of `LegacyPage`. Signed-out visitors never reach these routes (the proxy redirects them to sign-in), so the button is always valid to show.
  - `src/components/shell/legacy-page.tsx`: stays (org and project pages still use it until SENTRA-36 to 38). If nothing uses it after this story, delete it (fallow).
  - `src/app/page.tsx` (`/`):
    - `PageHeader` with the title "Your organizations" and the page's single "Create organization" link-button.
    - A `Card` containing the org list (`data-testid="org-list"`). Each row is a link with the org name as its accessible name, the slug in mono, and a chevron icon (`aria-hidden`).
    - A "More organizations" link when `nextCursor` is set.
    - First page with no orgs: `EmptyState` (`testId="no-orgs"`, text includes "You are not in any organization yet."), with the description pointing to the header's "Create organization" button or to an invitation.
    - Org list fails: `ErrorState` (`testId="api-unavailable"`) with `correlationId`, so it renders "Reference: <id>".
    - Footer: when `/v1/me` succeeds, a muted line "Support ID: `<code data-testid="user-id">…</code>`". When it fails, the line is omitted.
    - The `signed-in` test ID is unused by every spec (checked with grep). It may be kept on the footer line or dropped.
  - `src/app/orgs/new/page.tsx` + `new-org-form.tsx`:
    - "All organizations" back link, then a `Card` with the title "Create organization".
    - `Label`/`Input` for "Name" and "Slug". The current constraints stay: `required`, `maxLength`, `minLength`, `pattern`.
    - Below the slug: a muted live URL preview `/orgs/<slug>` (mono) and the hint "Used in the URL. It cannot be changed later."
    - Form-level error `role="alert"` with `data-testid="form-error"`.
    - Submit button named "Create organization", `aria-busy` while pending.
    - The slug suggestion from the name (`slugify`) stays.
  - `src/app/invitations/accept/page.tsx` + `accept-form.tsx`:
    - A `Card` with the title "Join an organization".
    - With a token: an explanation and the "Accept invitation" button, `aria-busy` while pending.
    - Without a token: an error with `data-testid="accept-error"` ("This invitation link is not valid.").
    - Action errors: `role="alert"` with `data-testid="accept-error"`.
    - "Back to home" link.
    - The page still makes no API call on load and never consumes the token on GET.
  - `src/app/invitations/accept/actions.ts`: copy only. The `invitation_email_mismatch` message gains explicit recovery steps. Draft: "This invitation was sent to a different email address. Sign out, sign in with the invited address (it must be verified), then open the invitation link from the email again." Must still contain "different email address" (e2e). The other messages stay, with only light edits allowed; "already used or was cancelled" must still match (e2e).
  - `src/components/ui/{card,input,label}.tsx`: shadcn stock, pruned to the exports that are used (fallow).
  - `e2e/helpers.ts`: a new `screenshotPath(feature: string, name: string): string`. It returns `../../docs/features/<feature>/screenshots/<name>` when `process.env.SENTRA_E2E_DOC_SCREENSHOTS === "1"`, otherwise `test-results/screenshots/<feature>/<name>`. Each spec's `SHOTS`/`PRIORITY_SHOTS` constants are replaced by calls to it; the feature folder names are unchanged.
  - `e2e/accessibility.spec.ts`, `e2e/shell.spec.ts`: new cases (see Verification).
- Request and data flow: unchanged. `/` still calls `GET /v1/me` and `GET /v1/orgs[?cursor]` through `callApi`. `/orgs/new` and `/invitations/accept` make no API call on render. The server actions `createOrganization` and `acceptInvitation` are unchanged apart from copy.
- API, event, and storage contracts: none changed.
- Selector compatibility contract. These must stay exactly as they are; existing specs depend on them:
  - Test IDs: `user-id`, `no-orgs`, `org-list`, `api-unavailable`, `form-error`, `accept-error`.
  - `/`: exactly one link named "Create organization" (strict mode, so the `EmptyState` must not add a second one), exactly one button named "Sign out", and org links inside `org-list` named by the org name.
  - `/orgs/new`: labels "Name" and "Slug" (Playwright `getByLabel` does substring matching, so no other label may contain "Name"); exactly one button named "Create organization".
  - `/invitations/accept`: exactly one button named "Accept invitation".
  - Existing assertion text: "already taken", "different email address", "already used or was cancelled", "Reference:".
- Compatibility and migration: no data migration. Contributors who want committed doc screenshots must now set `SENTRA_E2E_DOC_SCREENSHOTS=1`; document this in `apps/web/Taskfile.yml` (a comment on, or variant of, the e2e task) or in the web README.

## Workload and targets

| Dimension                 | Expected value or range                                                                                               | Source or assumption      | Validation                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------- |
| Traffic and peak requests | Unknown; local/dev scale                                                                                              | No production traffic yet | N/A                                            |
| API calls per page view   | `/`: 2 (unchanged); `/orgs/new`: 0; `/invitations/accept`: 0 on render                                                | Design                    | Code review; API logs in manual check          |
| Data size                 | `/` renders one API page of orgs (API default page size) plus "More organizations"                                    | Existing behavior         | Existing e2e                                   |
| Latency                   | No regression; no new calls                                                                                           | Design                    | Not gated                                      |
| Client JS                 | Client components limited to the two existing forms (slug suggestion and preview, pending state) and the theme toggle | Design                    | `next build` route sizes in the PR description |

## Edge cases and failure behavior

| Scenario                                                      | Expected behavior                                                                                                                                                 | Verification                                                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New user, no orgs                                             | `EmptyState` `no-orgs` with guidance; a single "Create organization" link on the page                                                                             | `organizations.spec.ts`, `members.spec.ts` (unchanged assertions)                                                                                                  |
| Org list API fails on `/`                                     | `ErrorState` `api-unavailable` with "Reference: <id>"; header "Sign out" still works; Support ID line omitted if `/v1/me` also fails                              | New e2e against the API-down server (port 3001)                                                                                                                    |
| More orgs than one page                                       | "More organizations" link to `/?cursor=...`                                                                                                                       | Code review + manual (existing behavior)                                                                                                                           |
| Long org names / slugs                                        | Truncate with ellipsis in list rows, full name in `title`; slug preview wraps or truncates without overflowing the card                                           | Manual at mobile width + screenshot                                                                                                                                |
| Slug invalid or reserved, slug taken, org limit               | Native validation for pattern/length; API 400/409/403 shown as form-level `form-error` alert (existing messages)                                                  | `organizations.spec.ts` (409)                                                                                                                                      |
| Create org with API down                                      | Form-level error "temporarily unavailable. Reference: <id>"                                                                                                       | Manual                                                                                                                                                             |
| Double submit                                                 | Button disabled with `aria-busy` while pending (existing `pending` behavior)                                                                                      | Manual                                                                                                                                                             |
| Accept page without token                                     | `accept-error` "This invitation link is not valid."; no form                                                                                                      | New axe case renders this state; manual                                                                                                                            |
| Email mismatch / expired / revoked / member limit / not found | Action error in `accept-error` with recovery copy; "Back to home" link                                                                                            | `invitations.spec.ts` (mismatch, revoked)                                                                                                                          |
| Signed-out visitor follows invite link                        | Proxy sends them through sign-in and back (unchanged)                                                                                                             | `invitations.spec.ts`                                                                                                                                              |
| JavaScript disabled                                           | All three pages render; forms submit through server actions (progressive enhancement); no slug suggestion or preview (user types the slug); theme toggle needs JS | Manual check with JS disabled. **Assumed** that `useActionState` forms with server actions submit without JS in Next 16.3.8; verify manually during implementation |
| Narrow viewport                                               | Single column, card fills width with padding, header controls fit (wordmark, theme toggle, Sign out)                                                              | Manual + mobile screenshot                                                                                                                                         |
| Screenshot env var unset                                      | Specs write only under gitignored `test-results/`; `git status` clean after a full e2e run                                                                        | Manual: run e2e, check `git status`                                                                                                                                |

## Security, observability, and rollout

- Authorization and tenant isolation: unchanged. No new endpoint, route handler, or API call. `/` shows only the orgs the API returns for the user.
- Sign-out: the header form posts to the existing `/auth/logout`, which keeps its Origin-header CSRF guard. The form adds nothing.
- Invitation token: still only in the URL and a hidden form field. It is never consumed on GET, never logged by new code, and never placed in a new cookie.
- Sensitive data: the user ID is an internal UUID, shown only to the signed-in user (unchanged exposure, smaller prominence). No email is displayed.
- New dependencies: none beyond shadcn copy-in components (which use the already-installed Radix and `cva`). Run `task security`.
- Logs, metrics, traces: no new server logic, so none are added. Existing `callApi` failure logging with correlation IDs still covers the error states.
- Rollout and rollback: ships with the web app. No flags, no migrations. Roll back by reverting the PR. Owner: apps/web.

## Acceptance criteria

- [ ] `/`, `/orgs/new` and `/invitations/accept` are built from design-system components (`Card`, `Input`, `Label`, `Button`, `PageHeader`, `EmptyState`, `ErrorState`) and no longer render inside `LegacyPage`/`[data-legacy]`.
- [ ] `CenteredLayout` shows a visible "Sign out" button (POST, works without JS) on all three pages. Only one "Sign out" button exists per page.
- [ ] `/` shows the user's orgs as a list of links (name plus mono slug) with "More organizations" pagination, never redirects, and shows exactly one "Create organization" link.
- [ ] `/` with no orgs shows an empty state (`no-orgs`) that explains how to create or join an organization.
- [ ] `/` when the org list fails shows an error state (`api-unavailable`) with "Reference: <correlation id>".
- [ ] `/` shows the user ID only as a muted "Support ID" footer line (`user-id`), omitted when `/v1/me` fails.
- [ ] `/orgs/new` shows a live `/orgs/<slug>` preview, keeps the slug suggestion and the "cannot be changed later" hint, and shows API errors in a form-level `form-error` alert.
- [ ] The submit buttons on `/orgs/new` and `/invitations/accept` are disabled with `aria-busy` while pending, and their accessible names are unchanged.
- [ ] `/invitations/accept` never accepts on GET. The email-mismatch error gives explicit recovery steps (sign out, sign in with the invited address, reopen the email link). The no-token state shows `accept-error`.
- [ ] All existing test IDs, accessible names and asserted texts listed in the selector compatibility contract still work, and every existing e2e spec passes with only the screenshot-path change.
- [ ] axe (wcag2a, wcag2aa, wcag21a, wcag21aa) reports no violations on `/` (signed in, empty state), `/orgs/new` and `/invitations/accept` (no token), in light and dark.
- [ ] With `SENTRA_E2E_DOC_SCREENSHOTS` unset, a full e2e run leaves no modified or untracked files under `docs/`. With it set to `1`, screenshots are written to the same docs folders as before.
- [ ] Light and dark screenshots of all three pages, plus one mobile-width screenshot, are committed under `docs/features/SENTRA-35-ui-entry-onboarding/screenshots/` and linked in the PR by commit-SHA permalinks.
- [ ] The follow-ups below are recorded in YouTrack (new stories, or a note on SENTRA-36) and linked from this spec.

## Implementation plan

Dependency-ordered; one PR, one or more commits per step.

1. **E2E screenshot helper** (no dependencies).
   - Add `screenshotPath(feature, name)` to `e2e/helpers.ts`.
   - Replace the `SHOTS`/`PRIORITY_SHOTS` usages in the 12 specs: audit-events, finding-detail, findings, investigation-summary, investigations, invitations, members, organizations, projects, sbom-upload, shell, sign-in.
   - Check whether Playwright creates missing parent folders for `page.screenshot({ path })`. **Assumed** it does; verify on the first run.
   - Document `SENTRA_E2E_DOC_SCREENSHOTS=1`.
   - Expected: a full e2e run leaves `git status` clean; with the env var set, the files land in the docs folders.
   - Tests: the existing e2e suite. A unit test is not needed (trivial branching), unless fallow or the reviewer asks for one.
2. **shadcn components** (no dependencies). Run `shadcn add card input label` and fix the `cn` quirk.
   - Expected: lint, typecheck and fallow clean once they are used. Fallow rejects unused exports, so do this step together with steps 3 to 5, or prune what goes unused.
3. **`CenteredLayout`** (depends on 2).
   - Add the header "Sign out" form.
   - Render a centered content column without `LegacyPage`.
   - Remove the body "Sign out" from `/` in the same commit, so only one button exists.
   - Expected: `sign-in.spec.ts` passes unchanged.
4. **`/` org picker** (depends on 2 and 3).
   - `PageHeader` with the single "Create organization" link-button.
   - `Card` org list with "More organizations".
   - `EmptyState` `no-orgs`, `ErrorState` `api-unavailable`, and the Support ID footer.
   - Expected: `organizations.spec.ts`, `members.spec.ts`, `sign-in.spec.ts` and the `shell.spec.ts` degraded test pass.
   - Tests: an e2e check that `/` on the API-down server (reuse the `startWebWithoutApi` server already started in the `shell.spec.ts` degraded test, so `next dev` boots only once) shows `api-unavailable` with "Reference:" and that "Sign out" is visible.
5. **`/orgs/new`** (depends on 2 and 3).
   - Card form, `Label`/`Input`, slug URL preview, hint, form-level alert, `aria-busy` pending with a stable accessible name.
   - Expected: `organizations.spec.ts`, `projects.spec.ts` and the `createOrg` helper users pass.
   - Tests: if the preview text is computed by a pure function, a Vitest unit test (empty slug, normal slug). Otherwise covered by e2e plus manual checks.
6. **`/invitations/accept`** (depends on 2 and 3).
   - Card layout, recovery copy in `actions.ts`, `aria-busy` pending, "Back to home".
   - Expected: `invitations.spec.ts` passes.
   - Tests: existing e2e (mismatch, revoked, success).
7. **Accessibility cases** (depends on 4 to 6). Extend `e2e/accessibility.spec.ts`, light and dark:
   - `/orgs/new` and `/invitations/accept` without a token, using the placeholder `sentra_session` cookie (no API calls on render);
   - `/` after `signUp` (empty state).
   - Expected: zero violations.
8. **Cleanup and docs** (depends on 3 to 7).
   - Delete `LegacyPage` only if it is unused (it is still expected to be used by org and project pages).
   - Remove `legacy` CSS that only these pages relied on, if any.
   - Take screenshots (light, dark, mobile) into `docs/features/SENTRA-35-ui-entry-onboarding/screenshots/`.
   - Update this spec with verified assumptions and deviations.
   - Record the follow-ups in YouTrack.
   - A learning note is not expected (applies SENTRA-34 patterns). Add one only if implementation teaches something non-obvious, such as progressive enhancement of server-action forms.

## Verification

- Manual checks and expected results:
  - New user signs in and lands on `/`: the empty state, one "Create organization" button, "Sign out" in the header, and the Support ID in the footer.
  - Create an org: the slug is suggested and the `/orgs/<slug>` preview updates live. Submitting a duplicate slug shows the "already taken" alert. Success redirects to the org page.
  - With two or more orgs, `/` lists them; long names truncate.
  - Invitation: signed in with the wrong account, the mismatch copy gives recovery steps. Following them (header Sign out, sign in as the invitee, reopen the link) accepts the invitation.
  - Accept page without a token: the invalid-link state.
  - Toggle light, dark and system: all three pages are readable; check the mobile width.
  - JavaScript disabled: pages render, sign-out works, and creating an org with a manually typed slug works (validates the **Assumed** progressive-enhancement claim).
  - API stopped: `/` shows the error state with a reference ID.
  - Full e2e run without the env var: `git status` is clean.
- Automated tests and what they prove:
  - Existing Playwright specs: the selector compatibility contract holds and there are no flow regressions.
  - New axe cases: WCAG 2 A/AA in both themes on the three pages.
  - New API-down check for `/`: the failure state renders with a reference.
  - Vitest for any extracted pure helper.
- Load or failure tests: N/A beyond the API-down e2e.

## Definition of done

- `task lint`, `task format:check`, `task typecheck`, `task test`, `task web:test:e2e` (with `task stack:up` and `task stack:bootstrap`), `task security`, and `task fallow` pass. Fallow findings are fixed, not suppressed.
- No generated `AGENTS.md`/`CLAUDE.md` committed; no stray shadcn `cn` dependency; `git status` shows no untracked generated files.
- Screenshots committed and linked by commit-SHA permalinks in the PR (PR template completed, YouTrack story URL and this spec linked).
- This spec updated with outcomes of the **Assumed** items and any deviations.
- YouTrack SENTRA-35 updated with the acceptance criteria and a link to this spec; follow-ups recorded.

## Follow-ups

To record as YouTrack stories, or as a note on the named story. Not implemented here.

1. **Invitation preview endpoint.** A read-only lookup of an invitation by token: org name, role, inviter, expiry. The accept page shows "Join <org> as <role>" before accepting. It needs its own security design: token probing and rate limits, audit, and what to reveal when the email does not match or the invitation has expired or been revoked.
2. **Sign out and switch account, returning to the invitation.** `/auth/logout` accepts a `returnTo` form field validated by `safeReturnPath` and stored in the `sentra_return_to` cookie, so that after re-sign-in the user lands back on `/invitations/accept?token=...`. Design it together with item 1. Verify against the running Zitadel stack that the cookie survives provider logout and that the proxy does not overwrite it.
3. **Sign-out in the org shell** (owner: SENTRA-36). Inside `/orgs/**` there is currently no way to sign out without going back to `/`.
4. **Account email display** (with item 3). Show the signed-in email in the account area. This needs the email from `/v1/me` or the session; today `GET /v1/me` returns only `{ id }`.

## Open questions and assumptions to validate

- **Assumed:** `useActionState` forms backed by server actions submit without JavaScript in Next 16.3.8 (progressive enhancement). Validate manually in step 5; if false, record it as a known limitation (current pages behave the same).
- **Assumed:** Playwright `page.screenshot({ path })` creates missing parent folders. Validate on the first run of step 1.
- **Assumed:** every e2e locator on these pages is covered by the selector compatibility contract above (checked with grep across `apps/web/e2e` during planning). Revalidate with a full e2e run.
- Owner for all three: the implementer, before opening the PR.
