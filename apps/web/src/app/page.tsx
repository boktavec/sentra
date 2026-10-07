import { redirect } from "next/navigation";
import { apiGet, type ApiResult } from "@/lib/api";
import { accessTokenFor, currentSessionId, destroySession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Resolves the signed-in session's token, or sends the visitor to sign in. */
async function requireSession(): Promise<{ sessionId: string; token: string }> {
  const sessionId = await currentSessionId();
  const token = sessionId ? await accessTokenFor(sessionId) : null;
  if (!sessionId || !token) redirect("/auth/login");
  return { sessionId, token };
}

function UserStatus({ me }: { me: ApiResult<{ id: string }> }) {
  if (me.ok) {
    return (
      <p data-testid="signed-in">
        Signed in. Your Sentra user ID: <code data-testid="user-id">{me.data.id}</code>
      </p>
    );
  }
  return (
    <p data-testid="api-unavailable">
      Signed in, but the service is temporarily unavailable. Reference: {me.correlationId}
    </p>
  );
}

export default async function Home() {
  const { sessionId, token } = await requireSession();

  const me = await apiGet<{ id: string }>("/v1/me", token);
  if (!me.ok && me.status === 401) {
    await destroySession(sessionId);
    redirect("/auth/login");
  }

  return (
    <main>
      <h1>Sentra</h1>
      <UserStatus me={me} />
      <form action="/auth/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
