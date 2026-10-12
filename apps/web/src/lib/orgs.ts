import { cache } from "react";
import { notFound } from "next/navigation";
import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";

export interface Org {
  id: string;
  name: string;
  slug: string;
  role: "admin" | "member";
}

// Per-request memo: a layout and its page both look the org up, but the API is called once.
const lookupOrg = cache((slug: string) =>
  callApi((token) => apiGet<Org>(`/v1/orgs/by-slug/${encodeURIComponent(slug)}`, token)),
);

/** The first page of the signed-in user's organizations, for the switcher. */
export const listOrgs = cache(() =>
  callApi((token) =>
    apiGet<{ items: Pick<Org, "id" | "name" | "slug">[]; nextCursor: string | null }>(
      "/v1/orgs",
      token,
    ),
  ),
);

/**
 * Loads an organization by slug for the signed-in user. A missing org and an org the user does not
 * belong to look the same (the API returns 404 for both), and both render the not-found page.
 */
export async function fetchOrg(slug: string) {
  const org = await lookupOrg(slug);
  if (!org.ok && org.status === 404) notFound();
  return org;
}
