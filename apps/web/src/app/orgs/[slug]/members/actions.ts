"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiDelete, apiPatch, apiPost, type ApiResult } from "@/lib/api";
import { callApi } from "@/lib/auth";
import { config } from "@/lib/config";

const field = (form: FormData, name: string) => String(form.get(name) ?? "");
const memberPath = (form: FormData) =>
  `/v1/orgs/${encodeURIComponent(field(form, "orgId"))}/members/${encodeURIComponent(field(form, "userId"))}`;
const membersPage = (form: FormData) => `/orgs/${encodeURIComponent(field(form, "slug"))}/members`;

/** The API's status becomes a short code in the URL; the page turns it into a message. */
const errorCode = (result: ApiResult<unknown>) =>
  ({ 403: "forbidden", 404: "not_found", 409: "last_admin" })[result.ok ? 0 : result.status] ??
  "unavailable";

function finish(form: FormData, result: ApiResult<unknown>): never {
  redirect(result.ok ? membersPage(form) : `${membersPage(form)}?error=${errorCode(result)}`);
}

export async function changeRole(form: FormData) {
  const role = field(form, "role");
  finish(form, await callApi((token) => apiPatch(memberPath(form), token, { role })));
}

export async function removeMember(form: FormData) {
  finish(form, await callApi((token) => apiDelete(memberPath(form), token)));
}

/** Leaving twice is fine: once the user is out, the API answers 404 and that is still success. */
export async function leaveOrganization(form: FormData) {
  const result = await callApi((token) => apiDelete(memberPath(form), token));
  if (result.ok || result.status === 404) redirect("/");
  finish(form, result);
}

export interface InviteState {
  link?: string;
  error?: string;
}

const INVITE_MESSAGES: Record<string, string> = {
  invalid_input: "Enter a valid email address and a role.",
  invitation_limit_reached: "This organization has reached its invitation limit. Try again later.",
  forbidden: "Only admins can invite people.",
};

export async function createInvitation(_prev: InviteState, form: FormData): Promise<InviteState> {
  const orgId = encodeURIComponent(field(form, "orgId"));
  const result = await callApi((token) =>
    apiPost<{ token: string }>(`/v1/orgs/${orgId}/invitations`, token, {
      email: field(form, "email"),
      role: field(form, "role"),
    }),
  );
  if (!result.ok) {
    return {
      error:
        (result.code && INVITE_MESSAGES[result.code]) ||
        `The service is temporarily unavailable. Reference: ${result.correlationId}`,
    };
  }
  revalidatePath(membersPage(form));
  // The token is shown once, here; the API keeps only its hash.
  return {
    link: `${config().webUrl}/invitations/accept?token=${encodeURIComponent(result.data.token)}`,
  };
}

export async function revokeInvitation(form: FormData) {
  const path = `/v1/orgs/${encodeURIComponent(field(form, "orgId"))}/invitations/${encodeURIComponent(field(form, "invitationId"))}`;
  finish(form, await callApi((token) => apiDelete(path, token)));
}
