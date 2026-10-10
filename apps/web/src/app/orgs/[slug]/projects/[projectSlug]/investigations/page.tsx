import Link from "next/link";
import { fetchOrg } from "@/lib/orgs";
import { fetchProject } from "@/lib/projects";
import { listInvestigationFindings } from "@/lib/investigations";
import { InvestigationWorkspace } from "./workspace";

export const dynamic = "force-dynamic";

export default async function InvestigationsPage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const org = await fetchOrg(slug);
  if (!org.ok)
    return (
      <main>
        <p>Investigations are temporarily unavailable. Reference: {org.correlationId}</p>
      </main>
    );
  const project = await fetchProject(org.data.id, projectSlug);
  if (!project.ok)
    return (
      <main>
        <p>Investigations are temporarily unavailable. Reference: {project.correlationId}</p>
      </main>
    );
  const findings = await listInvestigationFindings(org.data.id, project.data.slug);
  return (
    <main>
      <p>
        <Link href={`/orgs/${slug}/projects/${projectSlug}`}>{project.data.name}</Link>
      </p>
      <h1>Investigations</h1>
      <p>Select an open finding to start an investigation or review its runs.</p>
      {findings.ok ? (
        <InvestigationWorkspace
          orgId={org.data.id}
          orgSlug={slug}
          projectSlug={project.data.slug}
          initial={findings.data}
        />
      ) : (
        <p role="alert">
          Findings are temporarily unavailable. Reference: {findings.correlationId}
        </p>
      )}
    </main>
  );
}
