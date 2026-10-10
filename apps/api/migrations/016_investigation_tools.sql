-- SENTRA-18: tenant-safe tools for investigations (ADR 0009). Additive; old workers keep running.
CREATE UNIQUE INDEX investigations_scope_identity_idx ON investigations (org_id, project_id, id);

-- Set by the worker when it claims an attempt; the tool token never outlives it.
ALTER TABLE investigations ADD COLUMN attempt_deadline_at timestamptz;
GRANT UPDATE (attempt_deadline_at) ON investigations TO sentra_intelligence;

ALTER TABLE investigations DROP CONSTRAINT investigations_failure_code_check;
ALTER TABLE investigations ADD CONSTRAINT investigations_failure_code_check
  CHECK (failure_code IN ('provider_unavailable', 'provider_timeout', 'provider_rejected', 'invalid_output',
                          'processing_error', 'attempts_exhausted',
                          'tool_unavailable', 'tool_unauthorized', 'deadline_exceeded'));

-- One row per authenticated tool call or token exchange, written only by the API. The worker role has
-- no grant on this table, so it cannot skip or forge entries. Append-only by convention: no code updates it.
-- `result` is the bounded body returned to the model, which makes it a private copy of tenant data
-- under the same undefined retention as investigation drafts.
CREATE TABLE investigation_tool_calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL,
  org_id           uuid NOT NULL,
  project_id       uuid NOT NULL,
  attempt          integer NOT NULL CHECK (attempt >= 1),
  -- 0 for a token exchange, which belongs to no model round.
  round            integer NOT NULL CHECK (round BETWEEN 0 AND 4),
  tool             text NOT NULL CHECK (tool IN ('get_finding_risk', 'list_related_findings',
                     'get_dependency_occurrences', 'lookup_advisory', 'token_exchange')),
  -- The validated arguments; NULL when they were invalid or the call takes none.
  args             jsonb,
  outcome          text NOT NULL CHECK (outcome IN ('ok', 'invalid_args', 'not_found', 'limit', 'error')),
  result           jsonb CHECK (result IS NULL OR result_bytes <= 8192),
  result_bytes     integer CHECK (result_bytes >= 0),
  duration_ms      integer NOT NULL CHECK (duration_ms >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, project_id, investigation_id) REFERENCES investigations (org_id, project_id, id),
  CHECK ((result IS NULL) = (result_bytes IS NULL))
);
CREATE INDEX investigation_tool_calls_run_idx ON investigation_tool_calls (investigation_id, attempt);
