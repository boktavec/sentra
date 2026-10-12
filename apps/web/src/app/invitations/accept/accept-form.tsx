"use client";

import { LoaderCircle } from "lucide-react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { acceptInvitation, type AcceptState } from "./actions";

export function AcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(acceptInvitation, {});

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      {state.error && (
        <p role="alert" data-testid="accept-error" className="text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}
        Accept invitation
      </Button>
    </form>
  );
}
