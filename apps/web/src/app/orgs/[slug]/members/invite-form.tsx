"use client";

import { useActionState } from "react";
import { createInvitation, type InviteState } from "./actions";

export function InviteForm({ orgId, slug }: { orgId: string; slug: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(createInvitation, {});
  return (
    <form action={action}>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="slug" value={slug} />
      <p>
        <label>
          Email <input name="email" type="email" required maxLength={254} />
        </label>{" "}
        <label>
          Role{" "}
          <select name="role" defaultValue="member" aria-label="Invitation role">
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>{" "}
        <button type="submit" disabled={pending}>
          Invite
        </button>
      </p>
      {state.error && (
        <p role="alert" data-testid="invite-error">
          {state.error}
        </p>
      )}
      {state.link && (
        <p data-testid="invite-link-box">
          Share this link with the invitee. It is shown only once:
          <br />
          <code data-testid="invite-link">{state.link}</code>
        </p>
      )}
    </form>
  );
}
