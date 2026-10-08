"use server";

import { redirect } from "next/navigation";
import { apiPost } from "@/lib/api";
import { callApi } from "@/lib/auth";

export interface FormState {
  error?: string;
}

const MESSAGES: Record<number, string> = {
  400: "Check the name and slug. Slugs are 3–40 lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen or use a reserved word.",
  404: "That organization was not found.",
  409: "That slug is already taken in this organization. Choose another.",
};

/** The API checks membership; the org ID from the form only picks which org to ask about. */
export async function createProject(_prev: FormState, form: FormData): Promise<FormState> {
  const orgId = String(form.get("orgId") ?? "");
  const orgSlug = String(form.get("orgSlug") ?? "");
  const result = await callApi((token) =>
    apiPost<{ slug: string }>(`/v1/orgs/${encodeURIComponent(orgId)}/projects`, token, {
      name: String(form.get("name") ?? ""),
      slug: String(form.get("slug") ?? ""),
    }),
  );
  if (result.ok) redirect(`/orgs/${encodeURIComponent(orgSlug)}/projects/${result.data.slug}`);
  return {
    error:
      MESSAGES[result.status] ??
      `The service is temporarily unavailable. Reference: ${result.correlationId}`,
  };
}
