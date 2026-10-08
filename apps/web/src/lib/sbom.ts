import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";
import type { SbomImport } from "./sbom-format.ts";

export type SbomPage = { items: SbomImport[]; nextCursor: string | null };

const base = (orgId: string, projectSlug: string) =>
  `/v1/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectSlug)}/sboms`;

export const listSboms = (orgId: string, projectSlug: string) =>
  callApi((token) => apiGet<SbomPage>(`${base(orgId, projectSlug)}?limit=20`, token));

export { base as sbomsPath };
