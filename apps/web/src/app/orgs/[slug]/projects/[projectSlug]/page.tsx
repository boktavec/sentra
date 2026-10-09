import Link from "next/link";
import { fetchOrg } from "@/lib/orgs";
import { fetchProject } from "@/lib/projects";
import { listSboms } from "@/lib/sbom";
import { SbomSection } from "./sbom-section";

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

  const sboms = await listSboms(org.data.id, project.data.slug);

  return (
    <main>
      <p>
        <Link href={`/orgs/${org.data.slug}`}>{org.data.name}</Link>
      </p>
      <h1 data-testid="project-name">{project.data.name}</h1>
      <p>
        Slug: <code data-testid="project-slug">{project.data.slug}</code>
      </p>
      <p>
        <Link href={`/orgs/${org.data.slug}/projects/${project.data.slug}/investigations`}>
          Investigations
        </Link>
      </p>
      {sboms.ok ? (
        <SbomSection
          orgId={org.data.id}
          projectSlug={project.data.slug}
          initial={sboms.data.items}
        />
      ) : (
        <p data-testid="api-unavailable">
          SBOM uploads are temporarily unavailable. Reference: {sboms.correlationId}
        </p>
      )}
    </main>
  );
}
