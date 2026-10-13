import Link from "next/link";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchOrg, type Org } from "@/lib/orgs";
import { listProjects } from "@/lib/projects";
import { NewProjectDialog } from "./projects/new-project-dialog";

export const dynamic = "force-dynamic";

async function Projects({ org, cursor }: { org: Org; cursor?: string }) {
  const page = await listProjects(org.id, cursor);

  if (!page.ok)
    return (
      <ErrorState
        testId="api-unavailable"
        title="Projects are temporarily unavailable"
        message="Try again shortly."
        correlationId={page.correlationId}
      />
    );

  const { items, nextCursor } = page.data;

  return (
    <DataTable
      testId="project-list"
      rows={items}
      rowKey={(project) => project.id}
      loadMoreLabel="More projects"
      loadMoreHref={
        nextCursor ? `/orgs/${org.slug}?cursor=${encodeURIComponent(nextCursor)}` : null
      }
      columns={[
        {
          key: "name",
          header: "Name",
          cell: (project) => (
            <Link
              href={`/orgs/${org.slug}/projects/${project.slug}`}
              title={project.name}
              className="block max-w-[28ch] truncate text-primary underline underline-offset-4"
            >
              {project.name}
            </Link>
          ),
        },
        {
          key: "slug",
          header: "Slug",
          cell: (project) => (
            <code className="font-mono text-muted-foreground">{project.slug}</code>
          ),
        },
      ]}
      empty={
        cursor ? undefined : (
          <EmptyState
            testId="no-projects"
            title="This organization has no projects yet."
            description="Projects hold the SBOMs and findings for one application."
            action={
              <NewProjectDialog
                orgId={org.id}
                orgSlug={org.slug}
                label="Create your first project"
                variant="outline"
              />
            }
          />
        )
      }
    />
  );
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
      <ErrorState
        testId="api-unavailable"
        title="The service is temporarily unavailable"
        message="Try again shortly."
        correlationId={org.correlationId}
      />
    );

  return (
    <>
      <PageHeader
        title={org.data.name}
        titleTestId="org-name"
        description={
          <>
            <code data-testid="org-slug" className="font-mono">
              {org.data.slug}
            </code>{" "}
            <Badge variant="outline" data-testid="org-role">
              {org.data.role}
            </Badge>
          </>
        }
        actions={
          <>
            {org.data.role === "admin" && (
              <Button asChild variant="outline">
                <Link href={`/orgs/${org.data.slug}/audit-events`}>Audit history</Link>
              </Button>
            )}
            <NewProjectDialog orgId={org.data.id} orgSlug={org.data.slug} label="New project" />
          </>
        }
      />
      <Projects org={org.data} cursor={cursor} />
    </>
  );
}
