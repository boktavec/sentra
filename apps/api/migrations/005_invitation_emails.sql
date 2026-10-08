-- SENTRA-29: transactional outbox for invitation emails. A row is written in the same transaction
-- as its invitation; a background sender delivers it. `body` holds the accept link (a secret) only
-- while the email is pending; it is cleared once the email is sent, cancelled, or finally failed.
CREATE TABLE invitation_emails (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id    uuid NOT NULL REFERENCES invitations (id),
  subject          text NOT NULL,
  body             text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  CHECK (status <> 'pending' OR body IS NOT NULL)
);

CREATE INDEX invitation_emails_due_idx ON invitation_emails (next_attempt_at) WHERE status = 'pending';
