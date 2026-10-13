import type { AuditFilters, AuditResult } from "./audits.ts";
import { fromLocalInputValue } from "./local-time.ts";

export type FilterField = keyof AuditFilters;

export interface FilterIssue {
  field: FilterField;
  message: string;
}

/** What the audit page reads from the URL: every value is untrusted text. */
export type RawAuditQuery = Partial<Record<FilterField, string>>;

const FILTER_FIELDS = ["from", "to", "actorId", "action", "result"] as const;

export const FILTER_ERROR_ID = "audit-filter-error";

/** The id of the alert item for a field, so the input can point to it with `aria-describedby`. */
export const issueId = (field: FilterField) => `${FILTER_ERROR_ID}-${field}`;

const MAX_ACTION_LENGTH = 100;

const STRICT_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;

/** What a `datetime-local` field submits without JavaScript: no zone, seconds optional. */
const BARE_LOCAL = /^(\d{4}-\d\d-\d\dT\d\d:\d\d)(:\d\d)?$/;

// Same pattern as the API (lowercase only), so a value that passes here is not rejected there.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RESULTS: readonly AuditResult[] = ["success", "failed"];

/** The seconds-precision prefix must survive a Date round trip, which rejects `2026-02-31`. */
function isRealInstant(iso: string) {
  const date = new Date(iso);

  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso.slice(0, 19));
}

/** Strict UTC ISO stays as is; a bare value (no-JS path) is read as UTC. Undefined when invalid. */
export function normalizeInstant(value: string): string | undefined {
  const bare = BARE_LOCAL.exec(value);
  const iso = bare ? `${bare[1]}${bare[2] ?? ":00"}Z` : value;

  return STRICT_UTC.test(iso) && isRealInstant(iso) ? iso : undefined;
}

const invalidDate = (field: "from" | "to"): FilterIssue => ({
  field,
  message: `Enter a valid date and time for ${field === "from" ? "From" : "To"}.`,
});

function dateFilters(query: RawAuditQuery) {
  const issues: FilterIssue[] = [];
  const filters: AuditFilters = {};

  for (const field of ["from", "to"] as const) {
    const raw = query[field]?.trim();

    if (!raw) continue;
    const iso = normalizeInstant(raw);

    if (iso) filters[field] = iso;
    else issues.push(invalidDate(field));
  }

  if (filters.from && filters.to && Date.parse(filters.from) >= Date.parse(filters.to))
    issues.push({ field: "to", message: "From must be earlier than To." });

  return { filters, issues };
}

function textFilters(query: RawAuditQuery) {
  const issues: FilterIssue[] = [];
  const filters: AuditFilters = {};
  const actorId = query.actorId?.trim().toLowerCase();
  const action = query.action?.trim();

  if (actorId) {
    filters.actorId = actorId;

    if (!UUID.test(actorId))
      issues.push({
        field: "actorId",
        message: "Actor ID must be a UUID, for example 3f2b8c1e-9d4a-4b7e-8c21-5a6f0d3e1b94.",
      });
  }

  if (action) {
    filters.action = action;

    if (action.length > MAX_ACTION_LENGTH)
      issues.push({ field: "action", message: "Action must be 1 to 100 characters." });
  }

  return { filters, issues };
}

/**
 * Validates the audit filters before the API sees them. `filters` holds the normalized values (dates
 * as strict UTC ISO) for the form and the next-page link; unparsable dates are dropped. The page
 * skips the API call when `issues` is not empty.
 */
export function parseAuditFilters(query: RawAuditQuery) {
  const dates = dateFilters(query);
  const text = textFilters(query);
  const result = RESULTS.find((outcome) => outcome === query.result);

  return {
    filters: {
      ...dates.filters,
      ...text.filters,
      ...(result && { result }),
    } satisfies AuditFilters,
    issues: [...dates.issues, ...text.issues],
  };
}

/** True when the URL carries any filter, valid or not, so "Clear filters" has something to clear. */
export const hasActiveFilters = (query: RawAuditQuery) =>
  FILTER_FIELDS.some((field) => Boolean(query[field]));

type SearchParams = Record<string, string | string[] | undefined>;

/** Next.js gives an array for a repeated parameter; the first value wins, so input never crashes the page. */
export function rawAuditQuery(search: SearchParams): RawAuditQuery & { cursor?: string } {
  const first = (name: string) => {
    const value = search[name];

    return Array.isArray(value) ? value[0] : value;
  };

  return {
    from: first("from"),
    to: first("to"),
    actorId: first("actorId"),
    action: first("action"),
    result: first("result"),
    cursor: first("cursor"),
  };
}

/** The query string for a submitted filter form: From/To (local wall-clock values) become strict UTC ISO. */
export function utcQueryFromForm(form: FormData): string {
  const params = new URLSearchParams();

  for (const field of FILTER_FIELDS) {
    const value = String(form.get(field) ?? "");
    const converted = field === "from" || field === "to" ? fromLocalInputValue(value) : value;

    if (converted) params.set(field, converted);
  }

  return params.toString();
}
