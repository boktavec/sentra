-- SENTRA-9: incremental sources (ghsa) resume from the newest advisory `updated_at` the last successful run
-- saw. It is written with the artifact (mark_stored) and only counts once the run is published or confirmed
-- unchanged, because the crawler reads it from the latest such run. A failed or half-finished run therefore
-- never moves it. NULL for sources that download a whole snapshot (osv, cisa-kev).
ALTER TABLE ingestion_runs ADD COLUMN watermark timestamptz;
