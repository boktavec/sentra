-- SENTRA-6: the pipeline parses a validated SBOM into one row per package. A parsed import has
-- status `parsed`; `validated` stays allowed for rows written by SENTRA-5 until they are reprocessed.
ALTER TABLE sbom_imports DROP CONSTRAINT sbom_imports_status_check;
ALTER TABLE sbom_imports ADD CONSTRAINT sbom_imports_status_check
  CHECK (status IN ('pending_upload', 'uploaded', 'validated', 'parsed', 'rejected', 'expired'));
ALTER TABLE sbom_imports DROP CONSTRAINT sbom_imports_reason_code_check;
ALTER TABLE sbom_imports ADD CONSTRAINT sbom_imports_reason_code_check
  CHECK (reason_code IN ('size', 'not_json', 'not_cyclonedx', 'unsupported_version', 'processing_failed',
                         'no_components', 'too_many_components'));
-- Set together with `parsed`: packages stored, and components left out (no usable purl).
ALTER TABLE sbom_imports ADD COLUMN dependency_count integer CHECK (dependency_count >= 0);
ALTER TABLE sbom_imports ADD COLUMN skipped_count integer CHECK (skipped_count >= 0);

-- One row per package per import. org_id and project_id are copied from the import row by the
-- pipeline, never from the file or the event. `purl` is the canonical Package URL; `ecosystem` is
-- the OSV ecosystem for its type, or NULL when the type has no mapping yet (stored, not matchable).
CREATE TABLE sbom_dependencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id   uuid NOT NULL REFERENCES sbom_imports (id),
  org_id      uuid NOT NULL REFERENCES organizations (id),
  project_id  uuid NOT NULL REFERENCES projects (id),
  purl        text NOT NULL,
  purl_type   text NOT NULL,
  namespace   text,
  name        text NOT NULL,
  version     text NOT NULL,
  ecosystem   text,
  scope       text NOT NULL CHECK (scope IN ('required', 'optional', 'excluded')),
  occurrences integer NOT NULL CHECK (occurrences >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_id, purl)
);
-- SENTRA-13 matches by ecosystem and package name.
CREATE INDEX sbom_dependencies_match_idx ON sbom_dependencies (ecosystem, name);
CREATE INDEX sbom_dependencies_project_idx ON sbom_dependencies (project_id);

GRANT SELECT, INSERT, DELETE ON sbom_dependencies TO sentra_pipeline;
GRANT UPDATE (dependency_count, skipped_count) ON sbom_imports TO sentra_pipeline;
