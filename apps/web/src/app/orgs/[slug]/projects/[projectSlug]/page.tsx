import Link from "next/link";
import { fetchOrg } from "@/lib/orgs";
import { fetchProject } from "@/lib/projects";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
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
  const project = await fetchProject(org.data.id, projectSlug);
  if (!project.ok) {
    return (
      <main>
        <p data-testid="api-unavailable">
          The service is temporarily unavailable. Reference: {project.correlationId}
        </p>
      </main>
    );
  }

  return (
    <main>
      <p>
        <Link href={`/orgs/${org.data.slug}`}>{org.data.name}</Link>
      </p>
      <h1 data-testid="project-name">{project.data.name}</h1>
      <p>
        Slug: <code data-testid="project-slug">{project.data.slug}</code>
      </p>
    </main>
  );
}
