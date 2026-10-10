-- SENTRA-19 rollback (the forward order is migrate, new worker, new API). Run after stopping the worker and
-- redeploying the previous API (which stamps prompt_version 2 again), and before starting the previous worker.
-- That worker ignores prompt_version and would run version 3 rows on the plain-draft path, so queued and
-- running version 3 runs are failed here instead. Finished runs and their stored results are left alone.
UPDATE investigations
SET status = 'failed', failure_code = 'processing_error', lease_owner = NULL, lease_expires_at = NULL,
    completed_at = now(), updated_at = now()
WHERE prompt_version = 3 AND status IN ('queued', 'running');
