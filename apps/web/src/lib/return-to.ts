export const RETURN_COOKIE = "sentra_return_to";

/**
 * A path to send the visitor back to after sign-in. Only same-site paths are accepted: it must start
 * with exactly one `/`, so `//evil.test`, `/\evil.test` and absolute URLs all fall back to the home page.
 */
export function safeReturnPath(value: string | undefined): string {
  if (!value || value.length > 2048) return "/";
  if (!/^\/(?![/\\])[^\u0000-\u001f\u007f]*$/.test(value)) return "/";
  return value;
}
