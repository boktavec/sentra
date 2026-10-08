import Link from "next/link";
import { fetchOrg } from "@/lib/orgs";
import { listProjects } from "@/lib/projects";
import { NewProjectForm } from "./projects/new-project-form";

export const dynamic = "force-dynamic";

export default async function OrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { slug } = await params;
  const { cursor } = await searchParams;
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

  const projects = await listProjects(org.data.id, cursor);

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
      <h2>Projects</h2>
      {projects.ok ? (
        <>
          {projects.data.items.length === 0 && !cursor ? (
            <p data-testid="no-projects">This organization has no projects yet.</p>
          ) : (
            <ul data-testid="project-list">
              {projects.data.items.map((project) => (
                <li key={project.id}>
                  <Link href={`/orgs/${org.data.slug}/projects/${project.slug}`}>
                    {project.name}
                  </Link>{" "}
                  <code>{project.slug}</code>
                </li>
              ))}
            </ul>
          )}
          {projects.data.nextCursor && (
            <p>
              <Link
                href={`/orgs/${org.data.slug}?cursor=${encodeURIComponent(projects.data.nextCursor)}`}
              >
                More projects
              </Link>
            </p>
          )}
        </>
      ) : (
        <p data-testid="api-unavailable">
          Projects are temporarily unavailable. Reference: {projects.correlationId}
        </p>
      )}
      <h3>Create project</h3>
      <NewProjectForm orgId={org.data.id} orgSlug={org.data.slug} />
    </main>
  );
}
