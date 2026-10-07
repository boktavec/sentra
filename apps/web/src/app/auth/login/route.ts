import { NextResponse } from "next/server";
import { toErrorResponse, unavailable } from "@sentra/ts-platform";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { client, oidcConfig } from "@/lib/oidc";
import { LOGIN_COOKIE, cookieOptions } from "@/lib/session";
import { redis } from "@/lib/redis";

export async function GET() {
  try {
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    // Login attempts are short-lived server-side state, bound to this browser by a cookie.
    await redis().set(`login:${state}`, JSON.stringify({ verifier, nonce }), "EX", 600);

    const url = client.buildAuthorizationUrl(await oidcConfig(), {
      redirect_uri: config().redirectUri,
      scope: "openid profile email offline_access",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    logger.info({}, "login_started");
    const response = NextResponse.redirect(url);
    response.cookies.set(LOGIN_COOKIE, state, cookieOptions(600));
    return response;
  } catch (err) {
    logger.error({ err: String(err) }, "login_start_failed");
    const { status, headers, body } = toErrorResponse(
      unavailable("login_start_failed", err),
      crypto.randomUUID(),
    );
    return NextResponse.json(body, { status, headers });
  }
}
