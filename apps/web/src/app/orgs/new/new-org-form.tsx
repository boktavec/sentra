"use client";

import { useActionState, useState } from "react";
import { createOrganization, type FormState } from "./actions";

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

export function NewOrgForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createOrganization, {});
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <form action={action}>
      <p>
        <label>
          Name <br />
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
          Slug <br />
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
        <p role="alert" data-testid="form-error">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        Create organization
      </button>
    </form>
  );
}
