-- SENTRA-4: projects group one application's dependencies and findings under an organization.
CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations (id),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$'),
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE INDEX projects_org_created_idx ON projects (org_id, created_at, id);
