-- SENTRA-15: derived advisory severity, separate from SENTRA-14's project-specific risk priority.
ALTER TABLE vulnerabilities
  ADD COLUMN cvss_score numeric(3, 1) CHECK (cvss_score BETWEEN 0 AND 10),
  ADD COLUMN cvss_version text CHECK (cvss_version IN ('3.0', '3.1', '4.0')),
  ADD COLUMN cvss_calculated_at timestamptz,
  ADD CONSTRAINT cvss_score_version_pair CHECK ((cvss_score IS NULL) = (cvss_version IS NULL));

-- The backfill uses this partial index to find remaining rows without rescanning all advisories.
CREATE INDEX vulnerabilities_cvss_backfill_idx ON vulnerabilities (id)
  WHERE cvss_calculated_at IS NULL;

-- The project filter is always applied first. Score sorting joins the advisory row, so the
-- measured 25k-finding case determines whether a further index or denormalization is useful.
CREATE INDEX findings_project_status_idx ON findings (project_id, status);
