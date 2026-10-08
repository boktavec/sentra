-- SENTRA-11: canonical vulnerability records, normalized from raw source artifacts. Global reference
-- data like ingestion_runs: deliberately no tenant_id.

-- One row per advisory per source. (source, source_id) is the upsert key. A row is rewritten only when
-- the source's `modified` is newer or the adapter that produced it is newer (see the SENTRA-11 spec).
CREATE TABLE vulnerabilities (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                 text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 64),
  source_id              text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 256),
  aliases                text[] NOT NULL DEFAULT '{}',
  summary                text,
  details                text,
  published_at           timestamptz,
  modified_at            timestamptz NOT NULL,
  withdrawn_at           timestamptz,
  -- [{"type": "CVSS_V3", "vector": "CVSS:3.1/..."}], as the source gave them; scoring is SENTRA-14.
  severity               jsonb NOT NULL DEFAULT '[]',
  refs                   jsonb NOT NULL DEFAULT '[]',
  -- Provenance: the raw artifact and zip entry this row was last written from.
  source_artifact_sha256 text NOT NULL CHECK (source_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  source_entry           text NOT NULL,
  schema_version         integer NOT NULL,
  adapter_version        integer NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);
CREATE INDEX vulnerabilities_aliases_idx ON vulnerabilities USING gin (aliases);

-- Which packages an advisory affects. `versions` is the explicit list; ranges live in
-- vulnerability_ranges. Both are kept because sources give either or both.
CREATE TABLE vulnerability_affected (
  id               uuid PRIMARY KEY,
  vulnerability_id uuid NOT NULL REFERENCES vulnerabilities (id) ON DELETE CASCADE,
  ecosystem        text NOT NULL,
  package_name     text NOT NULL,
  purl             text,
  versions         text[] NOT NULL DEFAULT '{}'
);
-- SENTRA-13 matches by ecosystem and package name.
CREATE INDEX vulnerability_affected_match_idx ON vulnerability_affected (ecosystem, package_name);
CREATE INDEX vulnerability_affected_vuln_idx ON vulnerability_affected (vulnerability_id);

-- Range events in source order. Comparing versions is SENTRA-13's job, so they stay as text.
CREATE TABLE vulnerability_ranges (
  affected_id   uuid NOT NULL REFERENCES vulnerability_affected (id) ON DELETE CASCADE,
  range_index   integer NOT NULL,
  event_index   integer NOT NULL,
  range_type    text NOT NULL CHECK (range_type IN ('SEMVER', 'ECOSYSTEM')),
  event_type    text NOT NULL CHECK (event_type IN ('introduced', 'fixed', 'last_affected')),
  event_version text NOT NULL,
  PRIMARY KEY (affected_id, range_index, event_index)
);

-- One row per artifact and adapter version. `claimed_until` is a lease so two workers never process
-- the same artifact at once. completed = records committed; published = the event was sent.
CREATE TABLE normalization_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  source          text NOT NULL,
  ecosystem       text NOT NULL,
  adapter_version integer NOT NULL,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'published', 'failed')),
  upserted        integer NOT NULL DEFAULT 0 CHECK (upserted >= 0),
  unchanged       integer NOT NULL DEFAULT 0 CHECK (unchanged >= 0),
  quarantined     integer NOT NULL DEFAULT 0 CHECK (quarantined >= 0),
  error           text,
  correlation_id  text NOT NULL,
  claimed_until   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_sha256, adapter_version)
);

-- Records that could not be normalized, traceable to the artifact and entry that produced them.
CREATE TABLE normalization_failures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  entry_name      text NOT NULL,
  adapter_version integer NOT NULL,
  error           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Reprocessing the same artifact updates the row instead of adding another.
  UNIQUE (artifact_sha256, entry_name, adapter_version)
);

-- Least-privilege role for the normalizer. NOLOGIN here because migrations must not hold secrets;
-- each environment grants login and sets the password (locally: `task stack:normalizer-role`).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentra_normalizer') THEN
    CREATE ROLE sentra_normalizer NOLOGIN;
  END IF;
END
$$;
GRANT SELECT, INSERT, UPDATE ON vulnerabilities TO sentra_normalizer;
GRANT SELECT, INSERT, DELETE ON vulnerability_affected TO sentra_normalizer;
GRANT SELECT, INSERT ON vulnerability_ranges TO sentra_normalizer;
GRANT SELECT, INSERT, UPDATE ON normalization_runs TO sentra_normalizer;
GRANT SELECT, INSERT, UPDATE ON normalization_failures TO sentra_normalizer;
