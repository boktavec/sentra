"use server";

import { redirect } from "next/navigation";
import { apiPost } from "@/lib/api";
import { callApi } from "@/lib/auth";

export interface FormState {
  error?: string;
}

const MESSAGES: Record<number, string> = {
  400: "Check the name and slug. Slugs are 3–40 lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen or use a reserved word.",
  403: "You have reached the maximum number of organizations.",
  409: "That slug is already taken. Choose another.",
};

export async function createOrganization(_prev: FormState, form: FormData): Promise<FormState> {
  const result = await callApi((token) =>
    apiPost<{ slug: string }>("/v1/orgs", token, {
      name: String(form.get("name") ?? ""),
      slug: String(form.get("slug") ?? ""),
    }),
  );
  if (result.ok) redirect(`/orgs/${result.data.slug}`);
  return {
    error:
      MESSAGES[result.status] ??
      `The service is temporarily unavailable. Reference: ${result.correlationId}`,
  };
}
