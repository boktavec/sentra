import { notFound } from "next/navigation";
import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";

export interface Org {
  id: string;
  name: string;
  slug: string;
  role: "admin" | "member";
}

/**
 * Loads an organization by slug for the signed-in user. A missing org and an org the user does not
 * belong to look the same (the API returns 404 for both), and both render the not-found page.
 */
export async function fetchOrg(slug: string) {
  const org = await callApi((token) =>
    apiGet<Org>(`/v1/orgs/by-slug/${encodeURIComponent(slug)}`, token),
  );
  if (!org.ok && org.status === 404) notFound();
  return org;
}
