import type { Finding } from "./findings.ts";
import type { Investigation } from "./investigations.ts";

export const SEVERITY_LEVELS = ["critical", "high", "medium", "low", "info"] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

/** The API's `severityCategory` is an open string; anything not on the scale (none, unavailable, new values) is `info`. */
export function severityLevel(category: string): SeverityLevel {
  return SEVERITY_LEVELS.find((level) => level === category) ?? "info";
}

export const STATUS_LABELS = {
  open: "Open",
  resolved: "Resolved",
  kev: "In CISA KEV",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
} as const;
export type StatusName = keyof typeof STATUS_LABELS;

export const findingStatusName = (status: Finding["status"]): StatusName => status;

/** Only a listed finding gets a KEV badge; "not listed" and "unavailable" are not signals worth a badge. */
export const kevStatusName = (status: Finding["kevStatus"]): StatusName | null =>
  status === "listed" ? "kev" : null;

export const runStatusName = (status: Investigation["status"]): StatusName =>
  status === "completed" ? "succeeded" : status;
