import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { client, oidcConfig } from "@/lib/oidc";
import { SESSION_COOKIE, destroySession, loadSession } from "@/lib/session";

export async function POST(request: NextRequest) {
  const { webUrl } = config();
  // CSRF guard: only our own pages may sign a user out.
  if (request.headers.get("origin") !== webUrl) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const id = request.cookies.get(SESSION_COOKIE)?.value;
  const session = id ? await loadSession(id) : null;
  if (id) await destroySession(id);
  logger.info({}, "logout");

  let destination = new URL("/", webUrl);
  try {
    // End the Zitadel session too, otherwise the next sign-in silently succeeds without a password.
    destination = client.buildEndSessionUrl(await oidcConfig(), {
      ...(session?.idToken ? { id_token_hint: session.idToken } : {}),
      post_logout_redirect_uri: webUrl,
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "end_session_url_failed");
  }
  const response = NextResponse.redirect(destination, 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
