"use server";

import { redirect } from "next/navigation";
import { apiPost } from "@/lib/api";
import { callApi } from "@/lib/auth";

export interface FormState {
  error?: string;
}

const MESSAGES = new Map<number, string>([
  [
    400,
    "Check the name and slug. Slugs are 3–40 lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen or use a reserved word.",
  ],
  [404, "That organization was not found."],
  [409, "That slug is already taken in this organization. Choose another."],
]);

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

/** The API checks membership; the org ID from the form only picks which org to ask about. */
export async function createProject(_prev: FormState, form: FormData): Promise<FormState> {
  const orgId = field(form, "orgId");
  const orgSlug = field(form, "orgSlug");

  const result = await callApi((token) =>
    apiPost<{ slug: string }>(`/v1/orgs/${encodeURIComponent(orgId)}/projects`, token, {
      name: field(form, "name"),
      slug: field(form, "slug"),
    }),
  );

  if (result.ok) redirect(`/orgs/${encodeURIComponent(orgSlug)}/projects/${result.data.slug}`);

  return {
    error:
      MESSAGES.get(result.status) ??
      `The service is temporarily unavailable. Reference: ${result.correlationId}`,
  };
}
