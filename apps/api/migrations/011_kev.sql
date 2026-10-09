-- SENTRA-8: CISA Known Exploited Vulnerabilities. Global reference data: deliberately no tenant_id.

-- One row per CVE the catalog has ever listed. KEV has no per-record `modified`, so a row is rewritten
-- only when its content hash changes, it returns after removal, or a newer adapter produced it.
-- `removed_at` is a tombstone: the CVE left the catalog. "In KEV" means a row with removed_at IS NULL.
CREATE TABLE kev_entries (
  cve_id                 text PRIMARY KEY CHECK (cve_id ~ '^CVE-[0-9]{4}-[0-9]{4,}$'),
  vendor_project         text,
  product                text,
  name                   text,
  description            text,
  required_action        text,
  date_added             date NOT NULL,
  due_date               date,
  known_ransomware_use   text,
  cwes                   text[] NOT NULL DEFAULT '{}',
  notes                  text,
  content_hash           text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  removed_at             timestamptz,
  -- Provenance: the catalog snapshot that last wrote this row.
  catalog_version        text NOT NULL,
  date_released          timestamptz NOT NULL,
  source_artifact_sha256 text NOT NULL CHECK (source_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  adapter_version        integer NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Is this vulnerability in KEV? A row matches through its own id or any alias, so an OSV or GHSA
-- advisory that lists the CVE resolves the same as the cisa-kev row itself.
CREATE VIEW vulnerability_kev_status AS
SELECT v.id AS vulnerability_id,
       k.cve_id IS NOT NULL AS in_kev,
       k.cve_id AS kev_cve_id,
       k.date_added AS kev_date_added,
       k.due_date AS kev_due_date,
       k.known_ransomware_use AS kev_known_ransomware_use
FROM vulnerabilities v
LEFT JOIN LATERAL (
  SELECT cve_id, date_added, due_date, known_ransomware_use
  FROM kev_entries
  WHERE removed_at IS NULL AND cve_id = ANY (v.aliases || v.source_id)
  LIMIT 1
) k ON true;

GRANT SELECT, INSERT, UPDATE ON kev_entries TO sentra_normalizer;
