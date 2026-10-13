"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { NewProjectForm } from "./new-project-form";

/** Dialog content mounts only while open, so the form starts empty each time. */
export function NewProjectDialog({
  orgId,
  orgSlug,
  label,
  variant,
}: {
  orgId: string;
  orgSlug: string;
  label: string;
  variant?: "default" | "outline";
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant={variant}>{label}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Pick a name. The slug is used in URLs and cannot be changed later.
          </DialogDescription>
        </DialogHeader>
        <NewProjectForm orgId={orgId} orgSlug={orgSlug} />
      </DialogContent>
    </Dialog>
  );
}
