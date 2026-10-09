-- SENTRA-18 rollback (the forward order is migrate, new worker, new API). Run after stopping the worker and redeploying the previous API (which stamps
-- prompt_version 1 again), and before starting the previous worker. That worker ignores prompt_version
-- and would run version 2 rows as a single call with no tools, so they are failed here instead.
-- The investigation_tool_calls ledger and finished runs are left alone.
UPDATE investigations
SET status = 'failed', failure_code = 'processing_error', lease_owner = NULL, lease_expires_at = NULL,
    completed_at = now(), updated_at = now()
WHERE prompt_version = 2 AND status IN ('queued', 'running');
