# SENTRA-20: Organization audit history

Organization admins can now review a bounded, tenant-scoped history of safe audit fields. The API uses PostgreSQL’s existing append-only audit table, an additive result/failure schema migration, and `(created_at, id)` keyset pagination so new writes do not shift pages.

Successful changes remain atomic with their audit row. Failed sensitive requests are recorded independently after a verified membership is resolved, so an audit write outage cannot replace the original rejection. Every failed API request also produces one sanitized structured operator log event; these logs deliberately are not a compliance archive.

The read API returns an explicit allowlist rather than metadata because historical metadata can contain filenames. No new datastore, queue, or dependency was needed. Future operations work must set retention and alert thresholds from measured event volume; request IP behavior still needs proxy-deployment verification.
