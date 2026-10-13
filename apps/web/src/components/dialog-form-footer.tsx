import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";

/** Cancel plus a submit button that keeps its label while pending (aria-busy, disabled). */
export function DialogFormFooter({
  pending,
  submitLabel,
}: {
  pending: boolean;
  submitLabel: string;
}) {
  return (
    <DialogFooter>
      <DialogClose asChild>
        <Button type="button" variant="outline">
          Cancel
        </Button>
      </DialogClose>
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}
        {submitLabel}
      </Button>
    </DialogFooter>
  );
}
