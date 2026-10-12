import { AppError } from "@sentra/ts-platform";
import { fieldsOf, isString, type Json } from "./json.ts";

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "login",
  "logout",
  "me",
  "new",
  "orgs",
  "settings",
  "www",
]);

const invalid = (reason: string) => new AppError("invalid_input", 400, "Invalid input", { reason });

export const isUuid = (value: string) => UUID.test(value);

export function validateNewOrg(body: Json | undefined) {
  const { name, slug } = fieldsOf(body);

  if (!isString(name) || !isString(slug)) throw invalid("not_strings");
  const trimmed = name.trim();

  if (trimmed.length < 1 || trimmed.length > 80 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw invalid("name");
  }

  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) throw invalid("slug");

  return { name: trimmed, slug };
}

export function validateRole(body: Json | undefined): "admin" | "member" {
  const { role } = fieldsOf(body);

  if (role !== "admin" && role !== "member") throw invalid("role");

  return role;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateNewInvitation(body: Json | undefined) {
  const { email } = fieldsOf(body);

  if (!isString(email)) throw invalid("email");
  const normalized = email.trim().toLowerCase();

  if (normalized.length < 3 || normalized.length > 254 || !EMAIL.test(normalized)) {
    throw invalid("email");
  }

  return { email: normalized, role: validateRole(body) };
}

export function validateAcceptBody(body: Json | undefined): string {
  const { token } = fieldsOf(body);

  if (!isString(token)) throw invalid("token");

  return token;
}

export function encodeCursor(createdAt: string, orgId: string): string {
  return Buffer.from(JSON.stringify([createdAt, orgId])).toString("base64url");
}

/**
 * One page of a keyset-paged query that fetched `limit + 1` rows: the extra row only says there is more.
 * Rows carry their sort timestamp as text (`cursor_ts`) so the cursor round-trips exactly.
 */
export function toPage<R extends { id: string; cursor_ts: string }, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
) {
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    items: page.map(map),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
  };
}

export function decodeCursor(cursor: string) {
  try {
    const parts: Json = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));

    if (Array.isArray(parts)) {
      const [createdAt, orgId] = parts;

      if (
        isString(createdAt) &&
        /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/.test(createdAt) &&
        isString(orgId) &&
        isUuid(orgId)
      ) {
        return { createdAt, orgId };
      }
    }
  } catch {
    // fall through to the generic bad-cursor error
  }

  throw invalid("cursor");
}
