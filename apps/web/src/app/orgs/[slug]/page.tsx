import Link from "next/link";
import { fetchOrg, type Org } from "@/lib/orgs";
import { listProjects } from "@/lib/projects";
import { NewProjectForm } from "./projects/new-project-form";

export const dynamic = "force-dynamic";

type ProjectPage = Awaited<ReturnType<typeof listProjects>>;

function MoreProjects({ org, cursor }: { org: Org; cursor: string | null }) {
  if (!cursor) return null;
  return (
    <p>
      <Link href={`/orgs/${org.slug}?cursor=${encodeURIComponent(cursor)}`}>More projects</Link>
    </p>
  );
}

function ProjectResults({ org, cursor, page }: { org: Org; cursor?: string; page: ProjectPage }) {
  if (!page.ok)
    return (
      <p data-testid="api-unavailable">
        Projects are temporarily unavailable. Reference: {page.correlationId}
      </p>
    );
  if (page.data.items.length === 0 && !cursor)
    return <p data-testid="no-projects">This organization has no projects yet.</p>;
  return (
    <>
      <ul data-testid="project-list">
        {page.data.items.map((project) => (
          <li key={project.id}>
            <Link href={`/orgs/${org.slug}/projects/${project.slug}`}>{project.name}</Link>{" "}
            <code>{project.slug}</code>
          </li>
        ))}
      </ul>
      <MoreProjects org={org} cursor={page.data.nextCursor} />
    </>
  );
}

async function Projects({ org, cursor }: { org: Org; cursor?: string }) {
  return <ProjectResults org={org} cursor={cursor} page={await listProjects(org.id, cursor)} />;
}

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
  if (!org.ok)
    return (
      <main>
        <p data-testid="api-unavailable">
          The service is temporarily unavailable. Reference: {org.correlationId}
        </p>
      </main>
    );
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
        {org.data.role === "admin" && (
          <>
            {" "}
            · <Link href={`/orgs/${org.data.slug}/audit-events`}>Audit history</Link>
          </>
        )}
      </p>
      <h2>Projects</h2>
      <Projects org={org.data} cursor={cursor} />
      <h3>Create project</h3>
      <NewProjectForm orgId={org.data.id} orgSlug={org.data.slug} />
    </main>
  );
}
