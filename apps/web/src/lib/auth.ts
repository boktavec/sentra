import { redirect } from "next/navigation";
import type { ApiResult } from "./api.ts";
import { accessTokenFor, currentSessionId, destroySession } from "./session.ts";

/** Resolves the signed-in session's token, or sends the visitor to sign in. */
async function requireSession(): Promise<{ sessionId: string; token: string }> {
  const sessionId = await currentSessionId();
  const token = sessionId ? await accessTokenFor(sessionId) : null;
  if (!sessionId || !token) redirect("/auth/login");
  return { sessionId, token };
}

/**
 * Runs an API call with the signed-in user's token. No session, or a 401 from the API, ends the
 * session and sends the visitor to sign in. Every other outcome is returned for the caller to show.
 */
export async function callApi<T>(
  request: (accessToken: string) => Promise<ApiResult<T>>,
): Promise<ApiResult<T>> {
  const { sessionId, token } = await requireSession();
  const result = await request(token);
  if (!result.ok && result.status === 401) {
    await destroySession(sessionId);
    redirect("/auth/login");
  }
  return result;
}
