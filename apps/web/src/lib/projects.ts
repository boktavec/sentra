import { notFound } from "next/navigation";
import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";
import { fetchOrg } from "./orgs.ts";

interface Project {
  id: string;
  name: string;
  slug: string;
}

type ProjectPage = { items: Project[]; nextCursor: string | null };

export const listProjects = (orgId: string, cursor?: string) =>
  callApi((token) =>
    apiGet<ProjectPage>(
      `/v1/orgs/${orgId}/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      token,
    ),
  );

/** A missing project and one in an org the user is not in both return 404 and render not-found. */
export async function fetchProject(orgId: string, slug: string) {
  const project = await callApi((token) =>
    apiGet<Project>(`/v1/orgs/${orgId}/projects/by-slug/${encodeURIComponent(slug)}`, token),
  );
  if (!project.ok && project.status === 404) notFound();
  return project;
}

/** The org and project a page belongs to, or the correlation ID of the failure to show instead. */
export async function fetchProjectScope(orgSlug: string, projectSlug: string) {
  const org = await fetchOrg(orgSlug);
  if (!org.ok) return { ok: false as const, correlationId: org.correlationId };
  const project = await fetchProject(org.data.id, projectSlug);
  if (!project.ok) return { ok: false as const, correlationId: project.correlationId };
  return { ok: true as const, org: org.data, project: project.data };
}
