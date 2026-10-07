import Link from "next/link";
import { notFound } from "next/navigation";
import { apiGet } from "@/lib/api";
import { callApi } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface Org {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export default async function OrgPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await callApi((token) =>
    apiGet<Org>(`/v1/orgs/by-slug/${encodeURIComponent(slug)}`, token),
  );

  // A missing org and an org the user does not belong to look the same: the API returns 404 for both.
  if (!org.ok && org.status === 404) notFound();
  if (!org.ok) {
    return (
      <main>
        <p data-testid="api-unavailable">
          The service is temporarily unavailable. Reference: {org.correlationId}
        </p>
      </main>
    );
  }

  return (
    <main>
      <p>
        <Link href="/">All organizations</Link>
      </p>
      <h1 data-testid="org-name">{org.data.name}</h1>
      <p>
        Slug: <code data-testid="org-slug">{org.data.slug}</code>
      </p>
      <p>
        Your role: <strong data-testid="org-role">{org.data.role}</strong>
      </p>
    </main>
  );
}
