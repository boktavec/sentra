"use client";

import { useActionState } from "react";
import { acceptInvitation, type AcceptState } from "./actions";

export function AcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(acceptInvitation, {});
  return (
    <form action={action}>
      <input type="hidden" name="token" value={token} />
      {state.error && (
        <p role="alert" data-testid="accept-error">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        Accept invitation
      </button>
    </form>
  );
}
