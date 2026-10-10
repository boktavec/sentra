ALTER TABLE audit_events
  ADD COLUMN result text NOT NULL DEFAULT 'success' CHECK (result IN ('success', 'failed')),
  ADD COLUMN failure_code text,
  ALTER COLUMN target_id DROP NOT NULL;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_failure_code_check CHECK (
    (result = 'success' AND failure_code IS NULL) OR
    (result = 'failed' AND failure_code IS NOT NULL)
  );

DROP INDEX audit_events_org_idx;
CREATE INDEX audit_events_org_created_id_idx ON audit_events (org_id, created_at DESC, id DESC);
