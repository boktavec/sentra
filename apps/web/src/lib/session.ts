import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { client, oidcConfig } from "./oidc.ts";
import { config } from "./config.ts";
import { redis } from "./redis.ts";

export const SESSION_COOKIE = "sentra_session";
export const LOGIN_COOKIE = "sentra_login";
const REFRESH_SKEW_SECONDS = 30;

export interface Session {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accessExpiresAt: number; // epoch seconds
}

const key = (id: string) => `session:${id}`;

export const cookieOptions = (maxAge?: number) =>
  ({
    httpOnly: true,
    sameSite: "lax",
    secure: config().secureCookies,
    path: "/",
    ...(maxAge ? { maxAge } : {}),
  }) as const;

/** Tokens live only in Redis; the browser holds an opaque random session ID. */
export async function createSession(session: Session): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await redis().set(key(id), JSON.stringify(session), "EX", config().sessionIdleSeconds);
  return id;
}

export async function loadSession(id: string): Promise<Session | null> {
  // GETEX slides the idle timeout on use.
  const raw = await redis().getex(key(id), "EX", config().sessionIdleSeconds);
  return raw ? (JSON.parse(raw) as Session) : null;
}

export const destroySession = (id: string) => redis().del(key(id));

export async function currentSessionId(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/**
 * Returns a valid access token, refreshing server-side when near expiry. Returns null if the
 * session is gone or can no longer be refreshed (caller should send the user to sign in).
 * A short Redis lock stops parallel requests from burning a rotating refresh token twice.
 */
export async function accessTokenFor(id: string): Promise<string | null> {
  let session = await loadSession(id);
  if (!session) return null;
  const now = () => Math.floor(Date.now() / 1000);
  if (session.accessExpiresAt - now() > REFRESH_SKEW_SECONDS) return session.accessToken;
  if (!session.refreshToken) return null;

  const lock = `${key(id)}:refresh`;
  if (await redis().set(lock, "1", "EX", 10, "NX")) {
    try {
      const tokens = await client.refreshTokenGrant(await oidcConfig(), session.refreshToken);
      session = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? session.refreshToken,
        idToken: tokens.id_token ?? session.idToken,
        accessExpiresAt: now() + (tokens.expires_in ?? 300),
      };
      await redis().set(key(id), JSON.stringify(session), "EX", config().sessionIdleSeconds);
      return session.accessToken;
    } catch {
      await destroySession(id); // refresh token rejected or expired: the session is over
      return null;
    } finally {
      await redis().del(lock);
    }
  }
  // Another request is refreshing; wait briefly for its result.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const latest = await loadSession(id);
    if (latest && latest.accessExpiresAt - now() > REFRESH_SKEW_SECONDS) return latest.accessToken;
    if (!latest) return null;
  }
  return null;
}
