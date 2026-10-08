"use client";

import { useActionState, useState } from "react";
import { slugify } from "@/lib/slugify";
import { createProject, type FormState } from "./actions";

export function NewProjectForm({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createProject, {});
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <form action={action}>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <p>
        <label>
          Project name <br />
          <input
            name="name"
            value={name}
            required
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugEdited) setSlug(slugify(e.target.value));
            }}
          />
        </label>
      </p>
      <p>
        <label>
          Project slug <br />
          <input
            name="slug"
            value={slug}
            required
            minLength={3}
            maxLength={40}
            pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugEdited(true);
            }}
          />
        </label>
        <br />
        <small>Used in the URL. It cannot be changed later.</small>
      </p>
      {state.error && (
        <p role="alert" data-testid="project-form-error">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        Create project
      </button>
    </form>
  );
}
