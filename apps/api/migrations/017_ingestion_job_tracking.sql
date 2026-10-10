-- SENTRA-10: scheduled ingestion and run tracking. Additive: the SENTRA-7 claim path and manual
-- `crawler.request` runs keep working (their rows are created by the claim, with trigger = 'manual').
ALTER TABLE ingestion_runs
  -- What caused the run. `retry_of` is the first run of a failure chain, so retries are bounded per chain.
  ADD COLUMN trigger      text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('schedule', 'retry', 'manual')),
  ADD COLUMN retry_of     uuid REFERENCES ingestion_runs (run_id),
  -- Set when a worker first claims the run / when it reaches a terminal state.
  ADD COLUMN started_at   timestamptz,
  ADD COLUMN completed_at timestamptz,
  -- transient and expired failures are retried by the scheduler; permanent ones are not.
  ADD COLUMN failure_kind text CHECK (failure_kind IN ('transient', 'permanent', 'expired')),
  ADD CONSTRAINT ingestion_runs_failure_kind_status_check CHECK (failure_kind IS NULL OR status = 'failed');

-- Runs recorded before this migration: they started when created and ended when last updated.
UPDATE ingestion_runs
SET started_at = created_at,
    completed_at = CASE WHEN status IN ('published', 'unchanged', 'failed') THEN updated_at END;

-- `requested`: the scheduler recorded the run and published the request; no worker has claimed it yet.
ALTER TABLE ingestion_runs DROP CONSTRAINT ingestion_runs_status_check;
ALTER TABLE ingestion_runs ADD CONSTRAINT ingestion_runs_status_check
  CHECK (status IN ('requested', 'fetching', 'stored', 'published', 'unchanged', 'failed'));

-- The per-source cap counts active runs; retries look up the runs of one chain.
CREATE INDEX ingestion_runs_active_idx ON ingestion_runs (source, ecosystem)
  WHERE status IN ('requested', 'fetching', 'stored');
CREATE INDEX ingestion_runs_retry_of_idx ON ingestion_runs (retry_of) WHERE retry_of IS NOT NULL;

-- One row per schedule (`<source>/<ecosystem>`). `next_due_at` is moved forward with a compare-and-set in
-- the same transaction that records the run, so replicas never both fire the same tick, and a restart
-- resumes from here (a source that is due fires once, with no catch-up burst). The row lock also
-- serialises the cap check and retry inserts for that source. Times come from the database clock.
CREATE TABLE scheduler_leases (
  name        text PRIMARY KEY CHECK (char_length(name) BETWEEN 3 AND 129),
  next_due_at timestamptz NOT NULL DEFAULT now()
);

-- Least-privilege role for the scheduler. NOLOGIN here because migrations must not hold secrets;
-- locally `task stack:scheduler-role` grants login and sets the password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentra_scheduler') THEN
    CREATE ROLE sentra_scheduler NOLOGIN;
  END IF;
END
$$;
GRANT SELECT, INSERT, UPDATE ON ingestion_runs, scheduler_leases TO sentra_scheduler;
