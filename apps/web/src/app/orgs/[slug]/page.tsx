import Link from "next/link";
import { fetchOrg } from "@/lib/orgs";

export const dynamic = "force-dynamic";

export default async function OrgPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await fetchOrg(slug);
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
      <p>
        <Link href={`/orgs/${org.data.slug}/members`}>Members</Link>
      </p>
    </main>
  );
}
