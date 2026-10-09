-- SENTRA-17: durable investigation lifecycle. The finding context is captured at creation.
CREATE UNIQUE INDEX findings_scope_identity_idx ON findings (org_id, project_id, id);

CREATE TABLE investigations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  finding_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  context_version integer NOT NULL DEFAULT 1,
  context_snapshot jsonb NOT NULL,
  model_id text NOT NULL,
  prompt_version integer NOT NULL DEFAULT 1,
  draft text,
  failure_code text CHECK (failure_code IN ('provider_unavailable', 'provider_timeout', 'provider_rejected', 'invalid_output', 'processing_error', 'attempts_exhausted')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, project_id, finding_id) REFERENCES findings (org_id, project_id, id),
  CHECK ((status = 'completed') = (draft IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX investigations_one_active_idx ON investigations (finding_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX investigations_history_idx ON investigations (org_id, project_id, finding_id, created_at DESC, id DESC);
CREATE INDEX investigations_due_idx ON investigations (next_attempt_at, id)
  WHERE status = 'queued';
CREATE INDEX investigations_expired_idx ON investigations (lease_expires_at, id)
  WHERE status = 'running';

CREATE TABLE investigation_outbox (
  event_id uuid PRIMARY KEY,
  investigation_id uuid NOT NULL REFERENCES investigations (id),
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX investigation_outbox_due_idx ON investigation_outbox (next_attempt_at)
  WHERE sent_at IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentra_intelligence') THEN
    CREATE ROLE sentra_intelligence NOLOGIN;
  END IF;
END $$;
GRANT SELECT ON investigations TO sentra_intelligence;
GRANT UPDATE (status, draft, failure_code, attempts, next_attempt_at, lease_owner,
              lease_expires_at, started_at, completed_at, updated_at)
  ON investigations TO sentra_intelligence;
