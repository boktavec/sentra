import { NextResponse, type NextRequest } from "next/server";
import { toErrorResponse, unauthenticated } from "@sentra/ts-platform";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { client, oidcConfig } from "@/lib/oidc";
import { redis } from "@/lib/redis";
import { LOGIN_COOKIE, SESSION_COOKIE, cookieOptions, createSession } from "@/lib/session";

export async function GET(request: NextRequest) {
  const correlationId = crypto.randomUUID();
  const fail = (reason: string, err?: unknown) => {
    logger.warn({ correlationId, reason, err: err ? String(err) : undefined }, "login_failed");
    const { status, headers, body } = toErrorResponse(unauthenticated(reason, err), correlationId);
    const response = NextResponse.json(body, { status, headers });
    response.cookies.delete(LOGIN_COOKIE);
    return response;
  };

  const state = request.nextUrl.searchParams.get("state");
  if (!state || state !== request.cookies.get(LOGIN_COOKIE)?.value) return fail("state_mismatch");
  const stored = await redis().getdel(`login:${state}`); // single use
  if (!stored) return fail("login_expired");
  const { verifier, nonce } = JSON.parse(stored) as { verifier: string; nonce: string };

  try {
    // Use the configured public URL, not the request's, so proxies/hosts can't alter the redirect URI.
    const callbackUrl = new URL(config().redirectUri);
    callbackUrl.search = request.nextUrl.search;
    const tokens = await client.authorizationCodeGrant(await oidcConfig(), callbackUrl, {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
    });
    const sessionId = await createSession({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      accessExpiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 300),
    });
    logger.info({ correlationId, subject: tokens.claims()?.sub }, "login_succeeded");
    const response = NextResponse.redirect(new URL("/", config().webUrl));
    response.cookies.set(SESSION_COOKIE, sessionId, cookieOptions());
    response.cookies.delete(LOGIN_COOKIE);
    return response;
  } catch (err) {
    return fail("code_exchange_failed", err);
  }
}
