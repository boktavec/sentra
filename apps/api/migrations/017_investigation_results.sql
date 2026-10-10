-- SENTRA-19: validated, structured investigation results (ADR 0010). Additive; legacy runs are untouched.

-- The number the model cites as `call:<n>`: 1-based per (investigation, attempt), assigned by the API when it
-- records a tool call. Token exchanges and rows written before this migration have none.
-- `truncated` keeps what the tool reported, because the stored result alone cannot say whether it was cut.
ALTER TABLE investigation_tool_calls ADD COLUMN call_no integer CHECK (call_no >= 1);
ALTER TABLE investigation_tool_calls ADD COLUMN truncated boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX investigation_tool_calls_call_no_idx
  ON investigation_tool_calls (investigation_id, attempt, call_no) WHERE call_no IS NOT NULL;

-- One immutable row per run, written only by the API in the transaction that completes the run. The worker
-- role has no grant on this table. `result` is a private copy of tenant data under the same open retention
-- follow-up as drafts and the tool-call ledger.
CREATE TABLE investigation_results (
  investigation_id uuid PRIMARY KEY,
  org_id           uuid NOT NULL,
  project_id       uuid NOT NULL,
  attempt          integer NOT NULL CHECK (attempt >= 1),
  schema_version   integer NOT NULL CHECK (schema_version >= 1),
  result           jsonb NOT NULL CHECK (octet_length(result::text) <= 32768),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, project_id, investigation_id) REFERENCES investigations (org_id, project_id, id)
);

-- A prompt version 3 run completes with a result row and no draft. Earlier versions still need a draft.
ALTER TABLE investigations DROP CONSTRAINT investigations_check;
ALTER TABLE investigations ADD CONSTRAINT investigations_draft_completed_check
  CHECK (draft IS NULL OR status = 'completed');
ALTER TABLE investigations ADD CONSTRAINT investigations_completed_output_check
  CHECK (status <> 'completed' OR draft IS NOT NULL OR prompt_version >= 3);
