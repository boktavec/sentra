"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { DialogFormFooter } from "@/components/dialog-form-footer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { createInvitation, type InviteState } from "./actions";

/** Mounts its content only while open, so closing discards the form and the one-time link. */
export function InviteDialog({ orgId, slug }: { orgId: string; slug: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Invite member</Button>
      </DialogTrigger>
      {open && <InviteContent orgId={orgId} slug={slug} onDone={() => setOpen(false)} />}
    </Dialog>
  );
}

function InviteContent({
  orgId,
  slug,
  onDone,
}: {
  orgId: string;
  slug: string;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState<InviteState, FormData>(createInvitation, {});
  // The link is shown once; until Done, nothing may dismiss the dialog by accident.
  const locked = Boolean(state.link);

  const keepOpenWhileLocked = (event: Event) => {
    if (locked) event.preventDefault();
  };

  return (
    <DialogContent
      showCloseButton={!locked}
      onEscapeKeyDown={keepOpenWhileLocked}
      onPointerDownOutside={keepOpenWhileLocked}
      onInteractOutside={keepOpenWhileLocked}
    >
      {state.link ? (
        <InviteSent email={state.email} link={state.link} onDone={onDone} />
      ) : (
        <InviteForm
          orgId={orgId}
          slug={slug}
          action={action}
          pending={pending}
          error={state.error}
        />
      )}
    </DialogContent>
  );
}

function InviteForm({
  orgId,
  slug,
  action,
  pending,
  error,
}: {
  orgId: string;
  slug: string;
  action: (form: FormData) => void;
  pending: boolean;
  error?: string;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Invite member</DialogTitle>
        <DialogDescription>
          We email them a link to join. It expires, and you can revoke it.
        </DialogDescription>
      </DialogHeader>
      <form action={action} className="flex flex-col gap-5">
        <input type="hidden" name="orgId" value={orgId} />
        <input type="hidden" name="slug" value={slug} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-role">Invitation role</Label>
          <NativeSelect id="invite-role" name="role" defaultValue="member">
            <option value="member">member</option>
            <option value="admin">admin</option>
          </NativeSelect>
        </div>
        {error && (
          <p role="alert" data-testid="invite-error" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFormFooter pending={pending} submitLabel="Invite" />
      </form>
    </>
  );
}

function InviteSent({ email, link, onDone }: { email?: string; link: string; onDone: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => headingRef.current?.focus(), []);

  return (
    <>
      <DialogHeader>
        <DialogTitle
          tabIndex={-1}
          ref={headingRef}
          className="leading-snug outline-none [overflow-wrap:anywhere]"
        >
          Invitation sent to {email}
        </DialogTitle>
        <DialogDescription>
          Shown only once. Copy it now, or revoke and re-invite later.
        </DialogDescription>
      </DialogHeader>
      <div data-testid="invite-link-box" className="flex flex-col gap-3">
        <code
          data-testid="invite-link"
          className="rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all select-all"
        >
          {link}
        </code>
        <CopyButton text={link} />
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
