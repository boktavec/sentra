-- SENTRA-7: one row per ingestion run (a crawl.requested for a source + ecosystem). Global reference
-- data: deliberately no tenant_id. `run_id` is supplied by the requester so a redelivered request maps
-- to the same row. `claimed_until` is a lease so two workers never fetch the same run at once.
CREATE TABLE ingestion_runs (
  run_id         uuid PRIMARY KEY,
  source         text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 64),
  ecosystem      text NOT NULL CHECK (char_length(ecosystem) BETWEEN 1 AND 64),
  status         text NOT NULL DEFAULT 'fetching'
                 CHECK (status IN ('fetching', 'stored', 'published', 'unchanged', 'failed')),
  artifact_key   text,
  sha256         text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  etag           text,
  size_bytes     bigint CHECK (size_bytes >= 0),
  attempts       integer NOT NULL DEFAULT 0,
  error          text,
  correlation_id text NOT NULL,
  claimed_until  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- A stored or published run must point at its artifact.
  CHECK (status NOT IN ('stored', 'published') OR (artifact_key IS NOT NULL AND sha256 IS NOT NULL))
);

-- Latest successful run per source + ecosystem (supplies the ETag for conditional GETs).
CREATE INDEX ingestion_runs_latest_idx ON ingestion_runs (source, ecosystem, created_at DESC);
-- Finding runs stuck in a non-terminal state.
CREATE INDEX ingestion_runs_open_idx ON ingestion_runs (updated_at) WHERE status IN ('fetching', 'stored');

-- Least-privilege role for the crawler. NOLOGIN here because migrations must not hold secrets;
-- each environment grants login and sets the password (locally: `task stack:crawler-role`).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentra_crawler') THEN
    CREATE ROLE sentra_crawler NOLOGIN;
  END IF;
END
$$;
GRANT SELECT, INSERT, UPDATE ON ingestion_runs TO sentra_crawler;
