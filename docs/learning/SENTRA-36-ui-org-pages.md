# SENTRA-36: Revamp organization pages

## What was built

The org page, the members page and the audit-events page now use the design system instead of legacy markup, across three stacked PRs:

- **PR1:** the org page (projects table, "New project" dialog), a visible "Sign out" button in the shell header, and the removal of `LegacyPage` from the org frame.
- **PR2:** the members page (table with role controls), confirm dialogs for Remove, Leave and Revoke, an "Invite member" dialog that shows the one-time link, and a pending-invitations table.
- **PR3:** the audit-events page: friendly filters, times shown in the viewer's time zone, and validation instead of "temporarily unavailable" for bad filters. The members page's invitation expiry uses the same time component.

No API, auth, session or data-model change was made.

## Why it is designed this way

- **Store and exchange UTC, display local.** The API only ever receives strict UTC ISO strings (`2026-03-01T10:00:05Z`). The URL carries strict UTC on the JavaScript path; on the no-JS path it carries the bare `datetime-local` value, which the server reads as UTC and normalizes before calling the API. That keeps links shareable between people in different zones, keeps cursors bound to unambiguous filters, and keeps the API's contract unchanged. Only the rendering layer converts, and the exact UTC value stays in the `title` so a screenshot or a support ticket is never ambiguous.
- **Hydration-safe local time.** The server cannot know the viewer's zone, and rendering local text on the client in the first pass would not match the server HTML (a hydration mismatch). `LocalTime` therefore renders a fixed `YYYY-MM-DD HH:mm:ss UTC` string on the server and in the first client render, then swaps to local text in an effect. Cost: a brief text swap on load. The alternative (a timezone cookie so the server renders local time) would need a wall-clock-to-UTC conversion across DST on the server, which needs a time-zone library or Temporal.
- **Filters that work without JavaScript.** The filter form is a plain `<form method="get">`. With JavaScript, a submit handler converts the `datetime-local` values (which carry no zone) to UTC and pushes the URL. Without it, the browser submits a bare `YYYY-MM-DDTHH:mm`, which the server reads as UTC, and the hint under the form says "Times in UTC" until hydration changes it to the viewer's zone. Correctness never depends on the script; the script only improves the experience.
- **Validate user input as user input.** Filters are validated in the web before the API call (parseable real dates, From earlier than To, a lowercase UUID actor ID, an action of 1 to 100 characters), and each problem is reported next to the field and in one alert. An API 400 `invalid_input` (for example a tampered cursor) shows the same alert. Only real failures show the outage state with a correlation ID. Messages never echo what the user typed.
- **Progressive enhancement for dialogs and confirms.** A confirm for Remove, Leave and Revoke is a normal submit button. Once hydrated, its click is intercepted to open an `AlertDialog`, and the dialog's confirm calls `requestSubmit()` on the button's own form. Without JavaScript it submits directly, exactly as before the story. Creating a project or an invitation needs the dialog, so those two actions are unavailable without JavaScript (a documented limitation).
- **One-time secrets in a UI.** The invitation link is returned once by the create action, held only in the dialog's React state, and never put in a URL, cookie, storage, ref or log. While it is shown, Esc, outside clicks and the close button are disabled so it cannot be dismissed by accident; "Done" closes the dialog, which unmounts the content and drops the value. "Copy link" writes to the clipboard only on an explicit click, and the link stays selectable text if the clipboard fails.
- **Reuse over new pieces.** Native `<select>` for roles and the audit Result filter (keyboard, mobile and no-JS behavior come from the browser), one shared dialog footer, one `ConfirmSubmit`, one `FILTER_BAR_CLASS` shared by the server `FilterBar` and the client audit form.

## Alternatives considered

- **UTC everywhere:** simplest, but unfriendly to people reading "when did this happen". Rejected by the user.
- **Timezone cookie plus server-side local rendering:** no text swap, but needs DST-safe conversion on the server and a new piece of state. Rejected.
- **Local display with UTC date-only filters:** loses time-of-day filtering. Rejected.
- **Server-rendered confirm step (`?confirm=`):** works without JavaScript but adds a page and state per action. Rejected for the progressive `AlertDialog`.
- **A select for the audit action:** makes the web the owner of the API's action vocabulary. Rejected for a text input with a `<datalist>` of known actions; unknown values are still accepted. An API-published action list is a follow-up.
- **Actor names in audit events:** needs an API decision about joins, departed members and what non-admins see. Deferred; actors show as short IDs (full ID in `title`, "You" for the signed-in user).

## Tradeoffs

- A short UTC-to-local text swap on load; without JavaScript, times stay in labelled UTC.
- `title` tooltips (the exact UTC value) are not reachable by keyboard or touch.
- The audit filter inputs show a seconds field and a 12-hour clock in some locales, because second precision is supported end to end.
- A DST gap or overlap wall-clock time resolves the way the browser's `Date` resolves it (gap: moved forward; overlap: first occurrence). The resulting UTC value is what the URL and the tooltip show, so it is visible rather than silent.
- One extra `GET /v1/me` per audit page render, for the "You" marker. If it fails, actors render without it.
- Below `sm` the tables become stacked grids, which can lose table semantics in some screen readers.

- The audit "To" bound is exclusive (half-open range, `created_at < to`), matching the API. With second precision in the UI, an event at 10:00:05.5 is excluded by To = 10:00:05. This was a deliberate choice, not an oversight.

## Scaling implications

Page sizes are unchanged (the API default of 50 audit events, maximum 100). The client bundle gained only the dialogs, the confirm wrapper, the copy button, `LocalTime` and the audit filter form; tables remain server components. Time formatting is O(rows) with one `Intl.DateTimeFormat` per cell on the client after mount, which is negligible at 100 rows; if tables grow, hoist one formatter and memoize.

## Failure and security considerations

- Authorization is unchanged: the UI hides admin controls cosmetically, and the API re-checks everything. A non-admin sees "You do not have access to audit history." and no audit call is made for events.
- Member emails still render only for admins. The browser's time zone is read client-side only and never sent to the server.
- Filter values are validated in the web and again by the API, and encoded with `URLSearchParams`. A repeated query parameter (an array in Next.js) is reduced to its first value instead of crashing the page.
- Failures stay visible: a failed pending-invitations load shows an inline error with a reference while the members table still works; a failed `/v1/me` never blocks the audit table.
- A real `datetime-local` pitfall: a value set from script whose seconds differ from the field's step base is flagged `stepMismatch`, which blocks native form submit. `step="1"` makes second precision valid.

## Key concepts to understand

- UTC as the interchange format, local time as a presentation concern.
- Hydration: the first client render must equal the server HTML; do environment-dependent work in an effect.
- Progressive enhancement: build the no-JS behavior first, then intercept it.
- Treat invalid user input and service failure as different states with different messages.
- One-time secrets: keep them in memory only, make dismissal deliberate, and avoid every channel that persists or logs them.
- Client modules and server modules: a non-component export of a `"use client"` file is a reference, not a value, so shared constants live in plain modules.
