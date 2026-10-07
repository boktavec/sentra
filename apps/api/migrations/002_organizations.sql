CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$'),
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- role is `admin` only until SENTRA-3 widens the check.
CREATE TABLE memberships (
  org_id      uuid NOT NULL REFERENCES organizations (id),
  user_id     uuid NOT NULL REFERENCES users (id),
  role        text NOT NULL CHECK (role IN ('admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX memberships_user_idx ON memberships (user_id, created_at, org_id);

CREATE TABLE audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations (id),
  actor_user_id  uuid NOT NULL REFERENCES users (id),
  action         text NOT NULL,
  target_type    text NOT NULL,
  target_id      uuid NOT NULL,
  correlation_id text,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_org_idx ON audit_events (org_id, created_at);

-- Append-only: product code and ordinary SQL cannot change or remove audit rows.
-- The table owner can still drop the trigger; separate DB roles are future hardening.
CREATE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_change
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
