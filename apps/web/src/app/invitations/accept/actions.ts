"use server";

import { redirect } from "next/navigation";
import { apiPost } from "@/lib/api";
import { callApi } from "@/lib/auth";

export interface AcceptState {
  error?: string;
}

const MESSAGES: Record<string, string> = {
  invitation_email_mismatch:
    "This invitation was sent to a different email address. Sign in with the invited address, and make sure it is verified.",
  invitation_expired: "This invitation has expired. Ask an admin to send a new one.",
  invitation_unavailable: "This invitation was already used or was cancelled.",
  member_limit_reached: "This organization has reached its member limit. Ask an admin for help.",
  not_found: "This invitation link is not valid.",
};

const messageFor = (result: { code?: string; correlationId: string }) =>
  MESSAGES[result.code ?? ""] ??
  `The service is temporarily unavailable. Reference: ${result.correlationId}`;

export async function acceptInvitation(_prev: AcceptState, form: FormData): Promise<AcceptState> {
  const token = String(form.get("token") ?? "");
  const result = await callApi((tokenForApi) =>
    apiPost<{ slug: string }>("/v1/invitations/accept", tokenForApi, { token }),
  );
  if (result.ok) redirect(`/orgs/${encodeURIComponent(result.data.slug)}`);
  return { error: messageFor(result) };
}
