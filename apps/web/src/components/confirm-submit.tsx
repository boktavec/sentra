"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * A form's submit button that asks first. Once hydrated, the click opens a confirmation and the
 * confirm button submits the surrounding form; before hydration, or without JavaScript, it is
 * an ordinary submit button, so the action still works (unconfirmed).
 *
 * Deliberately not AlertDialogTrigger: that renders type="button" and would break the no-JS submit.
 */
export function ConfirmSubmit({
  label,
  title,
  description,
}: {
  label: string;
  title: string;
  description: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { pending } = useFormStatus();

  return (
    <>
      <Button
        ref={buttonRef}
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-busy={pending}
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // No Trigger, so Radix has nothing to return focus to.
            event.preventDefault();
            buttonRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="[overflow-wrap:anywhere]">{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {/* The dialog is portaled outside the form, so submit it through the button's form. */}
            <AlertDialogAction
              variant="destructive"
              onClick={() => buttonRef.current?.form?.requestSubmit()}
            >
              {label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
