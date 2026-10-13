/** Strict UTC ISO as the API returns it: `2026-03-01T10:00:05Z`, optionally with milliseconds. */
const UTC_ISO_PREFIX_LENGTH = "YYYY-MM-DDTHH:mm:ss".length;

/** `YYYY-MM-DD HH:mm:ss UTC`. Pure string work, so the server and the first client render match. */
export function formatUtc(iso: string): string {
  return `${iso.slice(0, UTC_ISO_PREFIX_LENGTH).replace("T", " ")} UTC`;
}

/** `YYYY-MM-DD HH:mm:ss CEST` in the viewer's zone (or `timeZone`, for tests). */
export function formatLocal(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(new Date(iso));

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} ${part("timeZoneName")}`;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The `datetime-local` value (`YYYY-MM-DDTHH:mm:ss`) that shows the instant `iso` in local time. */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso);

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * A `datetime-local` value is a local wall-clock time with no zone. `new Date` reads that form as
 * local time; a wall-clock time inside a DST gap or overlap resolves the way the browser resolves it.
 * Returns strict UTC ISO at seconds precision, or undefined when the value is empty or invalid.
 */
export function fromLocalInputValue(value: string): string | undefined {
  const date = new Date(value);

  if (!value || Number.isNaN(date.getTime())) return undefined;

  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
