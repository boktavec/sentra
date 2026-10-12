import type { Finding, FindingPriority } from "./findings.ts";

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

export const priorityLabel = ({ tier, modelVersion }: FindingPriority) =>
  `${tier} (model v${modelVersion})`;

const BASE_REASONS: Record<FindingPriority["baseReason"], (score: number | null) => string> = {
  kev_listed: () => "Listed in CISA KEV: base P1",
  cvss_high: (score) => `High or critical severity (CVSS ${score?.toFixed(1)}): base P2`,
  cvss_medium: (score) => `Medium severity (CVSS ${score?.toFixed(1)}): base P3`,
  cvss_unavailable: () => "Severity unavailable: treated as P3",
  cvss_low: (score) => `Low severity (CVSS ${score?.toFixed(1)}): base P4`,
};

/**
 * One sentence per factor behind a tier, in the order the model applies them. The API decided the
 * tier; this only words the codes it returned, and never claims exploitation data it does not have.
 */
export function explainPriority({ baseReason, scopeAdjusted, factors }: FindingPriority): string[] {
  const reasons = [BASE_REASONS[baseReason](factors.cvss.score)];

  if (factors.kev !== "listed") reasons.push(kevLabel(factors.kev));

  if (scopeAdjusted) reasons.push(`Scope ${factors.scope}: lowered one tier`);
  else if (factors.scope !== "required")
    reasons.push(`Scope ${factors.scope}: already the lowest tier`);

  if (factors.matchQuality === "unverifiable")
    reasons.push("Version could not be verified: tier unchanged");

  return reasons;
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

const RANGE_EVENT_LABELS = new Map([
  ["introduced", "Introduced in"],
  ["fixed", "Fixed in (per advisory range)"],
  ["last_affected", "Last affected"],
]);

/** The matcher's stored evidence (services/pipeline correlate/match.py); every field is optional because the API returns it as stored JSON. */
export interface MatchEvidence {
  rule?: string;
  package?: string;
  dependencyVersion?: string;
  comparator?: string | null;
  range?: { events?: readonly { type?: string; version?: string }[] };
}

interface RangeEvent {
  type: string;
  version: string;
}

function rangeEvents(range: MatchEvidence["range"]): RangeEvent[] | null {
  if (!Array.isArray(range?.events)) return null;
  const events: RangeEvent[] = [];

  for (const { type, version } of range.events) {
    if (type === undefined || version === undefined) return null;
    events.push({ type, version });
  }

  return events;
}

const eventFact = ({ type, version }: RangeEvent) => ({
  label: RANGE_EVENT_LABELS.get(type) ?? type,
  value: type === "introduced" && version === "0" ? "the first release (0)" : version,
});

type Summary = (pkg: string, version: string) => string;

/** Confirmed matches, by matcher rule. */
const CONFIRMED_SUMMARIES = new Map<string, Summary>([
  [
    "explicit_version",
    (pkg, version) => `Version ${version} of ${pkg} is listed in the advisory's affected versions.`,
  ],
  [
    "range",
    (pkg, version) =>
      `Version ${version} of ${pkg} falls inside an affected range of the advisory.`,
  ],
]);

/** Unverifiable matches, by reason, with the rule that produces each. */
const UNVERIFIABLE_SUMMARIES = new Map<string, { rule: string; summary: Summary }>([
  [
    "no_version_data",
    {
      rule: "no_version_data",
      summary: (pkg, version) =>
        `The advisory names ${pkg} but gives no versions or ranges, so Sentra cannot tell whether version ${version} is affected.`,
    },
  ],
  [
    "version_unparseable",
    {
      rule: "range",
      summary: (pkg, version) =>
        `Sentra could not read version ${version} of ${pkg} under the advisory's version ordering, so it cannot tell whether it is in the affected range.`,
    },
  ],
  [
    "range_malformed",
    {
      rule: "range",
      summary: (pkg, version) =>
        `The advisory's affected range for ${pkg} is malformed, so Sentra cannot tell whether version ${version} is affected.`,
    },
  ],
  [
    "ecosystem_unsupported",
    {
      rule: "range",
      summary: (pkg, version) =>
        `Sentra has no version ordering for this ecosystem yet, so it cannot tell whether version ${version} of ${pkg} is in the affected range.`,
    },
  ],
]);

function summaryFor(
  rule: string | undefined,
  matchQuality: "confirmed" | "unverifiable",
  matchReason: string | null,
): Summary | undefined {
  if (rule === undefined) return undefined;

  if (matchQuality === "confirmed")
    return matchReason === null ? CONFIRMED_SUMMARIES.get(rule) : undefined;
  const entry = matchReason === null ? undefined : UNVERIFIABLE_SUMMARIES.get(matchReason);

  return entry?.rule === rule ? entry.summary : undefined;
}

function rangeFacts(evidence: MatchEvidence): EvidenceExplanation["facts"] | null {
  const events = rangeEvents(evidence.range);

  if (!events) return null;

  const { comparator } = evidence;

  const compared =
    comparator === undefined || comparator === null
      ? []
      : [{ label: "Versions compared as", value: comparator }];

  return [...compared, ...events.map(eventFact)];
}

/**
 * Plain-language reading of the matcher's stored evidence (services/pipeline correlate/match.py).
 * Returns null for anything it does not recognize, so the page can show the raw JSON instead of
 * guessing. An unverifiable match always says what Sentra could not determine, never "affected".
 */
export function explainEvidence(
  evidence: MatchEvidence | null,
  matchQuality: "confirmed" | "unverifiable",
  matchReason: string | null,
): EvidenceExplanation | null {
  if (!evidence) return null;
  const { rule, package: pkg, dependencyVersion: version } = evidence;

  if (pkg === undefined || version === undefined) return null;
  const summary = summaryFor(rule, matchQuality, matchReason);
  const facts = rule === "range" ? rangeFacts(evidence) : [];

  return summary && facts ? { summary: summary(pkg, version), facts } : null;
}

const RESOLVED_REASONS = new Map([
  ["dependency_removed", "the dependency is no longer in the project"],
  ["version_changed", "the dependency version changed"],
  ["advisory_withdrawn", "the advisory was withdrawn"],
  ["advisory_updated", "the advisory was updated and no longer matches"],
]);

export const resolvedReasonLabel = (reason: string | null) =>
  (reason && RESOLVED_REASONS.get(reason)) ?? reason ?? "unknown reason";

/** The UTC calendar date of an ISO timestamp. */
export const formatDate = (iso: string) => iso.slice(0, 10);
