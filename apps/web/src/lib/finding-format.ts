import type { Finding } from "./findings.ts";

export const optionLabel = (value: string) =>
  value === "all" ? "All" : value[0]!.toUpperCase() + value.slice(1);

export function severityLabel({
  cvssScore,
  cvssVersion,
  severityCategory,
}: Pick<Finding["vulnerability"], "cvssScore" | "cvssVersion" | "severityCategory">) {
  return cvssScore === null
    ? "Severity unavailable"
    : `${optionLabel(severityCategory)} ${cvssScore.toFixed(1)} (CVSS ${cvssVersion})`;
}

export function kevLabel(status: Finding["kevStatus"]) {
  if (status === "listed") return "In CISA KEV";
  if (status === "not_listed") return "Not listed in ingested CISA KEV catalog";
  return "Exploitation data unavailable";
}

/**
 * The URL itself when a browser may follow it from our page: only http and https. Everything else
 * (javascript:, data:, relative or garbage strings, null) comes back null and is shown as plain text.
 * Advisory refs are copied from third-party sources, so this is checked on the parsed URL.
 */
export function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export interface EvidenceExplanation {
  summary: string;
  facts: { label: string; value: string }[];
}

const RANGE_EVENT_LABELS: Record<string, string> = {
  introduced: "Introduced in",
  fixed: "Fixed in (per advisory range)",
  last_affected: "Last affected",
};

interface RangeEvent {
  type: string;
  version: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function rangeEvents(range: unknown): RangeEvent[] | null {
  if (!isRecord(range) || !Array.isArray(range["events"])) return null;
  const events = range["events"] as unknown[];
  const valid = events.every(
    (e) => isRecord(e) && typeof e["type"] === "string" && typeof e["version"] === "string",
  );
  return valid ? (events as RangeEvent[]) : null;
}

const eventFact = ({ type, version }: RangeEvent) => ({
  label: RANGE_EVENT_LABELS[type] ?? type,
  value: type === "introduced" && version === "0" ? "the first release (0)" : version,
});

type Summary = (pkg: string, version: string) => string;

/** Confirmed matches, by matcher rule. */
const CONFIRMED_SUMMARIES: Record<string, Summary> = {
  explicit_version: (pkg, version) =>
    `Version ${version} of ${pkg} is listed in the advisory's affected versions.`,
  range: (pkg, version) =>
    `Version ${version} of ${pkg} falls inside an affected range of the advisory.`,
};

/** Unverifiable matches, by reason, with the rule that produces each. */
const UNVERIFIABLE_SUMMARIES: Record<string, { rule: string; summary: Summary }> = {
  no_version_data: {
    rule: "no_version_data",
    summary: (pkg, version) =>
      `The advisory names ${pkg} but gives no versions or ranges, so Sentra cannot tell whether version ${version} is affected.`,
  },
  version_unparseable: {
    rule: "range",
    summary: (pkg, version) =>
      `Sentra could not read version ${version} of ${pkg} under the advisory's version ordering, so it cannot tell whether it is in the affected range.`,
  },
  range_malformed: {
    rule: "range",
    summary: (pkg, version) =>
      `The advisory's affected range for ${pkg} is malformed, so Sentra cannot tell whether version ${version} is affected.`,
  },
  ecosystem_unsupported: {
    rule: "range",
    summary: (pkg, version) =>
      `Sentra has no version ordering for this ecosystem yet, so it cannot tell whether version ${version} of ${pkg} is in the affected range.`,
  },
};

function summaryFor(
  rule: unknown,
  matchQuality: "confirmed" | "unverifiable",
  matchReason: string | null,
): Summary | undefined {
  if (typeof rule !== "string") return undefined;
  if (matchQuality === "confirmed")
    return matchReason === null ? CONFIRMED_SUMMARIES[rule] : undefined;
  const entry = matchReason === null ? undefined : UNVERIFIABLE_SUMMARIES[matchReason];
  return entry?.rule === rule ? entry.summary : undefined;
}

function rangeFacts(evidence: Record<string, unknown>): EvidenceExplanation["facts"] | null {
  const events = rangeEvents(evidence["range"]);
  if (!events) return null;
  const compared =
    typeof evidence["comparator"] === "string"
      ? [{ label: "Versions compared as", value: evidence["comparator"] }]
      : [];
  return [...compared, ...events.map(eventFact)];
}

/**
 * Plain-language reading of the matcher's stored evidence (services/pipeline correlate/match.py).
 * Returns null for anything it does not recognize, so the page can show the raw JSON instead of
 * guessing. An unverifiable match always says what Sentra could not determine, never "affected".
 */
export function explainEvidence(
  evidence: unknown,
  matchQuality: "confirmed" | "unverifiable",
  matchReason: string | null,
): EvidenceExplanation | null {
  if (!isRecord(evidence)) return null;
  const { rule, package: pkg, dependencyVersion: version } = evidence;
  if (typeof pkg !== "string" || typeof version !== "string") return null;
  const summary = summaryFor(rule, matchQuality, matchReason);
  const facts = rule === "range" ? rangeFacts(evidence) : [];
  return summary && facts ? { summary: summary(pkg, version), facts } : null;
}

const RESOLVED_REASONS: Record<string, string> = {
  dependency_removed: "the dependency is no longer in the project",
  version_changed: "the dependency version changed",
  advisory_withdrawn: "the advisory was withdrawn",
  advisory_updated: "the advisory was updated and no longer matches",
};

export const resolvedReasonLabel = (reason: string | null) =>
  (reason && RESOLVED_REASONS[reason]) ?? reason ?? "unknown reason";

/** The UTC calendar date of an ISO timestamp. */
export const formatDate = (iso: string) => iso.slice(0, 10);
