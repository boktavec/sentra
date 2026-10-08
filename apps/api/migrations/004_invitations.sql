-- SENTRA-28: organization invitations. Only the SHA-256 of the token is stored.
CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations (id),
  email        text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  role         text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash   bytea NOT NULL UNIQUE,
  invited_by   uuid NOT NULL REFERENCES users (id),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_by  uuid REFERENCES users (id),
  accepted_at  timestamptz
);

-- One live invitation per address per org; inviting again replaces it.
CREATE UNIQUE INDEX invitations_pending_email_idx ON invitations (org_id, email) WHERE status = 'pending';
CREATE INDEX invitations_org_idx ON invitations (org_id, created_at);
