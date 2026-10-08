import { notFound } from "next/navigation";
import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";

export interface Project {
  id: string;
  name: string;
  slug: string;
}

export type ProjectPage = { items: Project[]; nextCursor: string | null };

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
