import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { accessTokenFor, currentSessionId, destroySession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const sessionId = await currentSessionId();
  const token = sessionId ? await accessTokenFor(sessionId) : null;
  if (!token) redirect("/auth/login");

  const me = await apiGet<{ id: string }>("/v1/me", token);
  if (!me.ok && me.status === 401) {
    await destroySession(sessionId!);
    redirect("/auth/login");
  }

  return (
    <main>
      <h1>Sentra</h1>
      {me.ok ? (
        <p data-testid="signed-in">
          Signed in. Your Sentra user ID: <code data-testid="user-id">{me.data.id}</code>
        </p>
      ) : (
        <p data-testid="api-unavailable">
          Signed in, but the service is temporarily unavailable. Reference: {me.correlationId}
        </p>
      )}
      <form action="/auth/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
