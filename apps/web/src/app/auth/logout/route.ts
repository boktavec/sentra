import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { client, oidcConfig } from "@/lib/oidc";
import { SESSION_COOKIE, destroySession, loadSession, type Session } from "@/lib/session";

/** Destroys the web session and returns it so its ID token can be used for provider logout. */
async function endWebSession(id: string | undefined): Promise<Session | null> {
  if (!id) return null;
  const session = await loadSession(id);
  await destroySession(id);
  return session;
}

/** End the provider session too, otherwise the next sign-in silently succeeds without a password. */
async function logoutDestination(session: Session | null): Promise<URL> {
  const { webUrl } = config();
  try {
    return client.buildEndSessionUrl(await oidcConfig(), {
      ...(session?.idToken ? { id_token_hint: session.idToken } : {}),
      post_logout_redirect_uri: webUrl,
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "end_session_url_failed");
    return new URL("/", webUrl);
  }
}

export async function POST(request: NextRequest) {
  // CSRF guard: only our own pages may sign a user out.
  if (request.headers.get("origin") !== config().webUrl) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const session = await endWebSession(request.cookies.get(SESSION_COOKIE)?.value);
  logger.info({}, "logout");

  const response = NextResponse.redirect(await logoutDestination(session), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
