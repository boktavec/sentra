import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { client, oidcConfig } from "./oidc.ts";
import { config } from "./config.ts";
import { redis } from "./redis.ts";

export const SESSION_COOKIE = "sentra_session";
export const LOGIN_COOKIE = "sentra_login";
const REFRESH_SKEW_SECONDS = 30;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 300;

export interface Session {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accessExpiresAt: number; // epoch seconds
}

const key = (id: string) => `session:${id}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const isFresh = (session: Session) => session.accessExpiresAt - nowSeconds() > REFRESH_SKEW_SECONDS;

export const cookieOptions = (maxAge?: number) =>
  ({
    httpOnly: true,
    sameSite: "lax",
    secure: config().secureCookies,
    path: "/",
    ...(maxAge ? { maxAge } : {}),
  }) as const;

const withoutUndefined = (values: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));

const expiryOf = (tokens: client.TokenEndpointResponse) =>
  nowSeconds() + (tokens.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS);

/** Builds a session from a token response; a refresh response may omit values it didn't rotate. */
export function sessionFromTokens(
  tokens: client.TokenEndpointResponse,
  previous?: Session,
): Session {
  return {
    ...previous,
    ...withoutUndefined({ refreshToken: tokens.refresh_token, idToken: tokens.id_token }),
    accessToken: tokens.access_token,
    accessExpiresAt: expiryOf(tokens),
  };
}

const saveSession = (id: string, session: Session) =>
  redis().set(key(id), JSON.stringify(session), "EX", config().sessionIdleSeconds);

/** Tokens live only in Redis; the browser holds an opaque random session ID. */
export async function createSession(session: Session): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await saveSession(id, session);
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

/** Refreshes with the provider and stores the result. A rejected refresh token ends the session. */
async function refresh(
  id: string,
  session: Session,
  refreshToken: string,
): Promise<Session | null> {
  try {
    const tokens = await client.refreshTokenGrant(await oidcConfig(), refreshToken);
    const renewed = sessionFromTokens(tokens, session);
    await saveSession(id, renewed);
    return renewed;
  } catch {
    await destroySession(id);
    return null;
  }
}

/** Another request holds the refresh lock; wait briefly for its result instead of refreshing twice. */
async function waitForRefresh(id: string): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const latest = await loadSession(id);
    if (!latest) return null;
    if (isFresh(latest)) return latest.accessToken;
  }
  return null;
}

/** A short Redis lock stops parallel requests from burning a rotating refresh token twice. */
async function refreshExclusively(
  id: string,
  session: Session,
  refreshToken: string,
): Promise<string | null> {
  const lock = `${key(id)}:refresh`;
  if (!(await redis().set(lock, "1", "EX", 10, "NX"))) return waitForRefresh(id);
  try {
    return (await refresh(id, session, refreshToken))?.accessToken ?? null;
  } finally {
    await redis().del(lock);
  }
}

/**
 * Returns a valid access token, refreshing server-side when near expiry. Returns null if the
 * session is gone or can no longer be refreshed (caller should send the user to sign in).
 */
export async function accessTokenFor(id: string): Promise<string | null> {
  const session = await loadSession(id);
  if (!session) return null;
  if (isFresh(session)) return session.accessToken;
  if (!session.refreshToken) return null;
  return refreshExclusively(id, session, session.refreshToken);
}
