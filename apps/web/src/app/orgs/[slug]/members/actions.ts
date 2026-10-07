"use server";

import { redirect } from "next/navigation";
import { apiDelete, apiPatch, type ApiResult } from "@/lib/api";
import { callApi } from "@/lib/auth";

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
