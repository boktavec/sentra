import { NextResponse, type NextRequest } from "next/server";
import { AppError, toErrorResponse, unauthenticated } from "@sentra/ts-platform";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { client, oidcConfig } from "@/lib/oidc";
import { redis } from "@/lib/redis";
import { RETURN_COOKIE, safeReturnPath } from "@/lib/return-to";
import {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  cookieOptions,
  createSession,
  sessionFromTokens,
} from "@/lib/session";

interface LoginState {
  state: string;
  verifier: string;
  nonce: string;
}

/** The `state` the provider echoed must match the one bound to this browser by cookie. */
function boundState(request: NextRequest): string {
  const state = request.nextUrl.searchParams.get("state");
  if (!state || state !== request.cookies.get(LOGIN_COOKIE)?.value) {
    throw unauthenticated("state_mismatch");
  }
  return state;
}

/** Loads the login attempt for this callback. Single use. */
async function takeLoginState(request: NextRequest): Promise<LoginState> {
  const state = boundState(request);
  const stored = await redis().getdel(`login:${state}`);
  if (!stored) throw unauthenticated("login_expired");
  return { state, ...(JSON.parse(stored) as { verifier: string; nonce: string }) };
}

async function exchangeCode(request: NextRequest, login: LoginState) {
  // Use the configured public URL, not the request's, so proxies/hosts can't alter the redirect URI.
  const callbackUrl = new URL(config().redirectUri);
  callbackUrl.search = request.nextUrl.search;
  try {
    return await client.authorizationCodeGrant(await oidcConfig(), callbackUrl, {
      pkceCodeVerifier: login.verifier,
      expectedState: login.state,
      expectedNonce: login.nonce,
    });
  } catch (err) {
    throw unauthenticated("code_exchange_failed", err);
  }
}

function failure(err: unknown, correlationId: string) {
  const reason = err instanceof AppError ? err.reason : "error";
  const detail = err instanceof Error ? String(err.cause ?? err) : String(err);
  logger.warn({ correlationId, reason, err: detail }, "login_failed");
  const { status, headers, body } = toErrorResponse(err, correlationId);
  const response = NextResponse.json(body, { status, headers });
  response.cookies.delete(LOGIN_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const correlationId = crypto.randomUUID();
  try {
    const tokens = await exchangeCode(request, await takeLoginState(request));
    const sessionId = await createSession(sessionFromTokens(tokens));
    logger.info({ correlationId, subject: tokens.claims()?.sub }, "login_succeeded");
    const returnTo = safeReturnPath(request.cookies.get(RETURN_COOKIE)?.value);
    const response = NextResponse.redirect(new URL(returnTo, config().webUrl));
    response.cookies.set(SESSION_COOKIE, sessionId, cookieOptions());
    response.cookies.delete(LOGIN_COOKIE);
    response.cookies.delete(RETURN_COOKIE);
    return response;
  } catch (err) {
    return failure(err, correlationId);
  }
}
