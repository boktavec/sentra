import { AppError } from "@sentra/ts-platform";

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

export function validateNewOrg(body: unknown): { name: string; slug: string } {
  const { name, slug } = (body ?? {}) as Record<string, unknown>;
  if (typeof name !== "string" || typeof slug !== "string") throw invalid("not_strings");
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw invalid("name");
  }
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) throw invalid("slug");
  return { name: trimmed, slug };
}

export function encodeCursor(createdAt: string, orgId: string): string {
  return Buffer.from(JSON.stringify([createdAt, orgId])).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: string; orgId: string } {
  try {
    const [createdAt, orgId] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [
      unknown,
      unknown,
    ];
    if (
      typeof createdAt === "string" &&
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/.test(createdAt) &&
      typeof orgId === "string" &&
      isUuid(orgId)
    ) {
      return { createdAt, orgId };
    }
  } catch {
    // fall through to the generic bad-cursor error
  }
  throw invalid("cursor");
}
