-- SENTRA-5: one row per uploaded SBOM. The API creates the row (pending_upload) and hands out a
-- presigned POST for `object_key`; the client uploads straight to object storage; `complete` moves
-- the row to uploaded; the pipeline validates the file and sets validated or rejected.
-- `object_key` is always chosen by the server from internal IDs, never from client input.
CREATE TABLE sbom_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations (id),
  project_id  uuid NOT NULL REFERENCES projects (id),
  created_by  uuid NOT NULL REFERENCES users (id),
  filename    text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  status      text NOT NULL DEFAULT 'pending_upload'
              CHECK (status IN ('pending_upload', 'uploaded', 'validated', 'rejected', 'expired')),
  reason_code text CHECK (reason_code IN
              ('size', 'not_json', 'not_cyclonedx', 'unsupported_version', 'processing_failed')),
  size_bytes  bigint CHECK (size_bytes > 0),
  sha256      text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- A rejection always says why; nothing else carries a reason.
  CHECK ((status = 'rejected') = (reason_code IS NOT NULL))
);

-- The project's list, newest first.
CREATE INDEX sbom_imports_project_idx ON sbom_imports (project_id, created_at DESC, id DESC);
-- The expiry sweep and the per-project pending cap.
CREATE INDEX sbom_imports_pending_idx ON sbom_imports (project_id, expires_at) WHERE status = 'pending_upload';

-- Transactional outbox for `sbom.uploaded`: written in the same transaction as the move to
-- uploaded, relayed to the broker by the API. `event_id` is the event's dedupe key.
CREATE TABLE sbom_outbox (
  event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id       uuid NOT NULL REFERENCES sbom_imports (id),
  payload         jsonb NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX sbom_outbox_due_idx ON sbom_outbox (next_attempt_at) WHERE sent_at IS NULL;

-- Least-privilege role for the pipeline, NOLOGIN like sentra_crawler (login is granted per
-- environment; locally `task stack:pipeline-role`). It can read imports and set only the
-- validation result, and only the API (table owner) can change anything else.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentra_pipeline') THEN
    CREATE ROLE sentra_pipeline NOLOGIN;
  END IF;
END
$$;
GRANT SELECT ON sbom_imports TO sentra_pipeline;
GRANT UPDATE (status, reason_code, size_bytes, sha256, updated_at) ON sbom_imports TO sentra_pipeline;
