import { notFound } from "next/navigation";
import { fetchProjectScope } from "@/lib/projects";
import { getFinding } from "@/lib/findings";
import { FindingDetailView } from "./detail-view";

export const dynamic = "force-dynamic";

function FindingUnavailable({ correlationId }: { correlationId: string }) {
  return (
    <main>
      <p role="alert" data-testid="finding-error">
        This finding is temporarily unavailable. Reference: {correlationId}
      </p>
    </main>
  );
}

export default async function FindingDetailPage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string; findingId: string }>;
}) {
  const { slug, projectSlug, findingId } = await params;
  const scope = await fetchProjectScope(slug, projectSlug);
  if (!scope.ok)
    return (
      <main role="alert">
        The service is temporarily unavailable. Reference: {scope.correlationId}
      </main>
    );
  const finding = await getFinding(scope.org.id, projectSlug, findingId);
  // Unknown, malformed and other-tenant IDs are the same 404, so they render the same page.
  if (!finding.ok)
    return finding.status === 404 ? (
      notFound()
    ) : (
      <FindingUnavailable correlationId={finding.correlationId} />
    );
  const base = `/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(projectSlug)}`;
  return <FindingDetailView finding={finding.data} base={base} projectName={scope.project.name} />;
}
