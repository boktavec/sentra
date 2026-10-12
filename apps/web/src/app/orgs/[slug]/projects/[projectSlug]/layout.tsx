import type { ReactNode } from "react";
import { EntitySwitcher } from "@/components/shell/entity-switcher";
import { LegacyPage } from "@/components/shell/legacy-page";
import { ShellHeader } from "@/components/shell/shell-header";
import { fetchOrg, type Org } from "@/lib/orgs";
import { fetchProject, listProjects } from "@/lib/projects";
import { switcherItems, type Named } from "@/lib/shell";

/** First page of the org's projects; if that call fails, only the current project. */
async function ProjectSwitcher({ org, project }: { org: Org; project: Named }) {
  const projects = await listProjects(org.id);
  const base = `/orgs/${encodeURIComponent(org.slug)}`;
  return (
    <EntitySwitcher
      noun="project"
      heading="Projects"
      currentSlug={project.slug}
      allHref={base}
      allLabel="All projects"
      items={switcherItems(projects.ok ? projects.data.items : null, project).map((item) => ({
        name: item.name,
        slug: item.slug,
        href: `${base}/projects/${encodeURIComponent(item.slug)}`,
      }))}
    />
  );
}

/** The org and project the API answered for; either is null when its lookup failed. */
async function lookupScope(orgSlug: string, projectSlug: string) {
  const orgLookup = await fetchOrg(orgSlug);
  if (!orgLookup.ok) return { org: null, project: null };
  const projectLookup = await fetchProject(orgLookup.data.id, projectSlug);
  return { org: orgLookup.data, project: projectLookup.ok ? projectLookup.data : null };
}

/**
 * Header for project routes (the org layout steps aside for them). Names come only from lookups
 * the API answered; org and project lookups are shared with the page through cache().
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const { org, project } = await lookupScope(slug, projectSlug);

  return (
    <>
      <ShellHeader
        org={org}
        project={project ?? undefined}
        switcher={org && project && <ProjectSwitcher org={org} project={project} />}
      />
      <LegacyPage>{children}</LegacyPage>
    </>
  );
}
