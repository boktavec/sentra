"use client";

import { LoaderCircle } from "lucide-react";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { orgPathPreview, slugify } from "@/lib/slugify";
import { createOrganization, type FormState } from "./actions";

export function NewOrgForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createOrganization, {});
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <form action={action} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="org-name">Name</Label>
        <Input
          id="org-name"
          name="name"
          value={name}
          required
          maxLength={80}
          autoComplete="organization"
          onChange={(e) => {
            setName(e.target.value);

            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="org-slug">Slug</Label>
        <Input
          id="org-slug"
          name="slug"
          value={slug}
          required
          minLength={3}
          maxLength={40}
          pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="org-slug-help"
          className="font-mono"
          onChange={(e) => {
            setSlug(e.target.value);
            setSlugEdited(true);
          }}
        />
        <p id="org-slug-help" className="text-xs text-muted-foreground">
          <code data-testid="slug-preview" className="font-mono break-all">
            {orgPathPreview(slug)}
          </code>
          <br />
          Used in the URL. It cannot be changed later.
        </p>
      </div>
      {state.error && (
        <p role="alert" data-testid="form-error" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending} aria-busy={pending} className="w-full">
        {pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}
        Create organization
      </Button>
    </form>
  );
}
