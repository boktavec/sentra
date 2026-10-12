export const RETURN_COOKIE = "sentra_return_to";

const MAX_PATH_LENGTH = 2048;

const hasControlCharacter = (value: string) =>
  Array.from(value, (char) => char.charCodeAt(0)).some((code) => code <= 0x1f || code === 0x7f);

/**
 * A path to send the visitor back to after sign-in. Only same-site paths are accepted: it must start
 * with exactly one `/`, so `//evil.test`, `/\evil.test` and absolute URLs all fall back to the home page.
 */
export function safeReturnPath(value: string | undefined): string {
  if (!value || value.length > MAX_PATH_LENGTH) return "/";

  if (!/^\/(?![/\\])/.test(value) || hasControlCharacter(value)) return "/";

  return value;
}
