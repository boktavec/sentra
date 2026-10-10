// Tool results are returned to a model, so every part is bounded and says when it was cut (ADR 0009).
// The values are provisional caps from the SENTRA-18 spec, to be tuned from measurements.
const MAX_TEXT_BYTES = 1024;
export const MAX_RESULT_BYTES = 8 * 1024;
const MAX_ALIASES = 10;
const MAX_ALIAS_BYTES = 128;
const MAX_EVIDENCE_BYTES = 2 * 1024;

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/**
 * Cuts to a budget measured as the text's size once JSON-escaped (a control character costs 6 bytes, a quote or
 * backslash 2), because the result cap counts serialized bytes. Never splits a character.
 */
function cutEscaped(text: string, maxBytes: number): string {
  let used = 0;
  let end = 0;
  // Every character costs at least one byte, so the first `maxBytes` characters are all that can fit.
  for (const char of text.slice(0, maxBytes)) {
    used += Buffer.byteLength(JSON.stringify(char)) - 2;
    if (used > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end);
}

/** Caps individual fields and remembers whether anything was cut. */
export class Bounds {
  truncated = false;

  text(value: string | null, maxBytes = MAX_TEXT_BYTES): string | null {
    if (value === null) return null;
    const cut = cutEscaped(value, maxBytes);
    if (cut !== value) this.truncated = true;
    return cut;
  }

  /** Always present text (identifiers), so the result type stays a string. */
  required(value: string, maxBytes = MAX_TEXT_BYTES): string {
    return this.text(value, maxBytes)!;
  }

  aliases(values: string[]): string[] {
    if (values.length > MAX_ALIASES) this.truncated = true;
    return values.slice(0, MAX_ALIASES).map((v) => this.required(v, MAX_ALIAS_BYTES));
  }

  /** Evidence is matcher output of unknown size: all of it, or null. */
  evidence(value: unknown): object | null {
    if (value === null || typeof value !== "object") return null;
    if (jsonBytes(value) <= MAX_EVIDENCE_BYTES) return value;
    this.truncated = true;
    return null;
  }
}

/**
 * Drops items from the end of `items` until `build(items)` fits the result cap. Returns the kept items.
 * Throws when even an empty list does not fit: the caps above are meant to make that impossible.
 */
export function fitItems<T>(items: T[], build: (kept: T[]) => unknown, bounds: Bounds): T[] {
  let kept = items;
  while (kept.length > 0 && jsonBytes(build(kept)) > MAX_RESULT_BYTES) {
    kept = kept.slice(0, -1);
    bounds.truncated = true;
  }
  if (jsonBytes(build(kept)) > MAX_RESULT_BYTES)
    throw new Error("tool result exceeds its size cap");
  return kept;
}

/**
 * Builds a result with everything, or with the optional bulk (evidence, aliases) dropped when that is too big.
 * Throws when even the reduced result does not fit: the field caps are meant to make that impossible.
 */
export function fitOptional<T>(build: (full: boolean) => T, bounds: Bounds): T {
  const full = build(true);
  if (jsonBytes(full) <= MAX_RESULT_BYTES) return full;
  bounds.truncated = true;
  const reduced = build(false);
  if (jsonBytes(reduced) > MAX_RESULT_BYTES) throw new Error("tool result exceeds its size cap");
  return reduced;
}
