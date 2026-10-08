-- SENTRA-13: match dependencies to vulnerabilities. `findings` is derived, tenant-scoped state that the
-- correlator (services/pipeline) reconciles per project; see ADR 0003.

-- A comparable package name, so one rule serves both sides of the join. `namespace` is the purl
-- namespace on the dependency side and NULL on the advisory side, whose package_name is already
-- combined (`@angular/core`, `group:artifact`, `github.com/foo/bar`). PyPI follows PEP 503 and npm names
-- are lowercase; every other ecosystem (Go included) joins namespace and name with `/` and compares exactly.
CREATE FUNCTION package_match_name(ecosystem text, namespace text, name text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE ecosystem
    WHEN 'PyPI' THEN lower(regexp_replace(name, '[-_.]+', '-', 'g'))
    WHEN 'npm' THEN lower(CASE WHEN namespace IS NULL OR namespace = '' THEN name ELSE namespace || '/' || name END)
    WHEN 'Maven' THEN CASE WHEN namespace IS NULL OR namespace = '' THEN name ELSE namespace || ':' || name END
    ELSE CASE WHEN namespace IS NULL OR namespace = '' THEN name ELSE namespace || '/' || name END
  END
$$;

ALTER TABLE sbom_dependencies
  ADD COLUMN match_name text GENERATED ALWAYS AS (package_match_name(ecosystem, namespace, name)) STORED;
ALTER TABLE vulnerability_affected
  ADD COLUMN match_name text GENERATED ALWAYS AS (package_match_name(ecosystem, NULL::text, package_name)) STORED;

-- Replace the (ecosystem, name) indexes reserved for this story: `name` omits the namespace.
DROP INDEX sbom_dependencies_match_idx;
DROP INDEX vulnerability_affected_match_idx;
CREATE INDEX sbom_dependencies_match_idx ON sbom_dependencies (ecosystem, match_name);
CREATE INDEX vulnerability_affected_match_idx ON vulnerability_affected (ecosystem, match_name);

-- "The project's latest parsed import".
CREATE INDEX sbom_imports_parsed_idx ON sbom_imports (project_id, created_at DESC, id DESC) WHERE status = 'parsed';

-- One row per project, dependency (purl includes the version) and advisory. Natural keys, because the
-- dependency and affected rows they were derived from are rebuilt on reprocessing. org_id and
-- project_id are copied from the dependency row by the correlator, never from an event.
CREATE TABLE findings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations (id),
  project_id       uuid NOT NULL REFERENCES projects (id),
  vulnerability_id uuid NOT NULL REFERENCES vulnerabilities (id),
  purl             text NOT NULL,
  version          text NOT NULL,
  ecosystem        text NOT NULL,
  scope            text NOT NULL CHECK (scope IN ('required', 'optional', 'excluded')),
  -- The import that last confirmed the finding.
  import_id        uuid NOT NULL REFERENCES sbom_imports (id),
  match_quality    text NOT NULL CHECK (match_quality IN ('confirmed', 'unverifiable')),
  match_reason     text CHECK (match_reason IN
                     ('version_unparseable', 'no_version_data', 'range_malformed', 'ecosystem_unsupported')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_reason  text CHECK (resolved_reason IN
                     ('dependency_removed', 'version_changed', 'advisory_withdrawn', 'advisory_updated')),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  matcher_version  integer NOT NULL,
  -- The rule that matched: explicit version or range bounds, comparator, the advisory's package name.
  evidence         jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, purl, vulnerability_id),
  CHECK ((match_quality = 'confirmed') = (match_reason IS NULL)),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL AND resolved_reason IS NOT NULL))
);
CREATE INDEX findings_project_idx ON findings (project_id, first_seen_at DESC, id);
CREATE INDEX findings_vulnerability_idx ON findings (vulnerability_id);

-- Forward work per import and matcher version, with a lease so two workers never take the same one.
CREATE TABLE match_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id            uuid NOT NULL REFERENCES sbom_imports (id),
  org_id               uuid NOT NULL REFERENCES organizations (id),
  project_id           uuid NOT NULL REFERENCES projects (id),
  matcher_version      integer NOT NULL,
  status               text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  confirmed            integer NOT NULL DEFAULT 0 CHECK (confirmed >= 0),
  unverifiable         integer NOT NULL DEFAULT 0 CHECK (unverifiable >= 0),
  resolved             integer NOT NULL DEFAULT 0 CHECK (resolved >= 0),
  unchanged            integer NOT NULL DEFAULT 0 CHECK (unchanged >= 0),
  unmatchable          integer NOT NULL DEFAULT 0 CHECK (unmatchable >= 0),
  error                text,
  correlation_id       text NOT NULL,
  claimed_until        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_id, matcher_version)
);

-- Named watermark over vulnerabilities.updated_at for the reverse path, and the sweep lease.
CREATE TABLE correlation_state (
  name          text PRIMARY KEY,
  watermark     timestamptz,
  claimed_until timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Least-privilege role for the correlator. NOLOGIN here because migrations must not hold secrets;
-- each environment grants login and sets the password (locally: `task stack:correlator-role`).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentra_correlator') THEN
    CREATE ROLE sentra_correlator NOLOGIN;
  END IF;
END
$$;
GRANT SELECT ON sbom_dependencies, sbom_imports, vulnerabilities, vulnerability_affected, vulnerability_ranges
  TO sentra_correlator;
GRANT SELECT, INSERT, UPDATE ON findings, match_runs, correlation_state TO sentra_correlator;
