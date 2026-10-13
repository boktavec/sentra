"use client";

import { LoaderCircle } from "lucide-react";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { slugify } from "@/lib/slugify";
import { createProject, type FormState } from "./actions";

export function NewProjectForm({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createProject, {});
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-name-input">Project name</Label>
        <Input
          id="project-name-input"
          name="name"
          value={name}
          required
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value);

            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-slug-input">Project slug</Label>
        <Input
          id="project-slug-input"
          name="slug"
          value={slug}
          required
          minLength={3}
          maxLength={40}
          pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="project-slug-help"
          className="font-mono"
          onChange={(e) => {
            setSlug(e.target.value);
            setSlugEdited(true);
          }}
        />
        <p id="project-slug-help" className="text-xs text-muted-foreground">
          Used in the URL. It cannot be changed later.
        </p>
      </div>
      {state.error && (
        <p role="alert" data-testid="project-form-error" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}
          Create project
        </Button>
      </DialogFooter>
    </form>
  );
}
