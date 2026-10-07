import Link from "next/link";
import { apiGet, type ApiResult } from "@/lib/api";
import { callApi } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface Org {
  id: string;
  name: string;
  slug: string;
}

type OrgPage = { items: Org[]; nextCursor: string | null };

function UserStatus({ me }: { me: ApiResult<{ id: string }> }) {
  if (!me.ok) return null;
  return (
    <p data-testid="signed-in">
      Signed in. Your Sentra user ID: <code data-testid="user-id">{me.data.id}</code>
    </p>
  );
}

function MoreLink({ cursor }: { cursor: string | null }) {
  if (!cursor) return null;
  return (
    <p>
      <Link href={`/?cursor=${encodeURIComponent(cursor)}`}>More organizations</Link>
    </p>
  );
}

function OrgItems({ page, firstPage }: { page: OrgPage; firstPage: boolean }) {
  if (page.items.length === 0 && firstPage) {
    return <p data-testid="no-orgs">You are not in any organization yet.</p>;
  }
  return (
    <>
      <ul data-testid="org-list">
        {page.items.map((org) => (
          <li key={org.id}>
            <Link href={`/orgs/${org.slug}`}>{org.name}</Link> <code>{org.slug}</code>
          </li>
        ))}
      </ul>
      <MoreLink cursor={page.nextCursor} />
    </>
  );
}

function OrgList({ orgs, firstPage }: { orgs: ApiResult<OrgPage>; firstPage: boolean }) {
  if (orgs.ok) return <OrgItems page={orgs.data} firstPage={firstPage} />;
  return (
    <p data-testid="api-unavailable">
      Signed in, but the service is temporarily unavailable. Reference: {orgs.correlationId}
    </p>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const me = await callApi((token) => apiGet<{ id: string }>("/v1/me", token));
  const orgs = await callApi((token) =>
    apiGet<OrgPage>(`/v1/orgs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, token),
  );

  return (
    <main>
      <h1>Sentra</h1>
      <UserStatus me={me} />
      <h2>Your organizations</h2>
      <OrgList orgs={orgs} firstPage={!cursor} />
      <p>
        <Link href="/orgs/new">Create organization</Link>
      </p>
      <form action="/auth/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
