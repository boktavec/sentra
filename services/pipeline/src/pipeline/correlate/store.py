"""Database access as the sentra_correlator role: run state, watermark, sweep lease and the project
queries behind the triggers. Autocommit; reconcile() opens its own transaction. The connection is
re-opened on the next call after it breaks, so a Postgres restart is a few retried events."""

from dataclasses import dataclass
from datetime import datetime

import psycopg

from .reconcile import MATCHER_VERSION, Result, reconcile

WATERMARK = "advisory_watermark"
SWEEP = "sweep"


@dataclass(frozen=True)
class ImportRow:
    org_id: str
    project_id: str
    status: str


class Store:
    def __init__(self, database_url: str):
        self.database_url = database_url
        self._conn: psycopg.Connection | None = None

    @property
    def conn(self) -> psycopg.Connection:
        if self._conn is None or self._conn.closed or self._conn.broken:
            self._conn = psycopg.connect(self.database_url, autocommit=True)
        return self._conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()

    def reconcile(self, project_id: str) -> Result:
        return reconcile(self.conn, project_id)

    # -- forward: one run per import and matcher version -------------------------------------------

    def import_row(self, import_id: str) -> ImportRow | None:
        row = self.conn.execute(
            "SELECT org_id::text, project_id::text, status FROM sbom_imports WHERE id = %s", (import_id,)
        ).fetchone()
        return ImportRow(*row) if row else None

    def claim_run(self, imp_id: str, row: ImportRow, correlation_id: str, lease_seconds: int) -> str | None:
        """None when the import was already reconciled by this matcher version or another worker holds it."""
        found = self.conn.execute(
            "INSERT INTO match_runs (import_id, org_id, project_id, matcher_version, correlation_id, claimed_until) "
            "VALUES (%s, %s, %s, %s, %s, now() + make_interval(secs => %s)) "
            "ON CONFLICT (import_id, matcher_version) DO UPDATE SET status = 'running', error = NULL, "
            "correlation_id = EXCLUDED.correlation_id, claimed_until = EXCLUDED.claimed_until, updated_at = now() "
            "WHERE match_runs.status = 'failed' "
            "OR (match_runs.status = 'running' AND match_runs.claimed_until < now()) "
            "RETURNING id",
            (imp_id, row.org_id, row.project_id, MATCHER_VERSION, correlation_id, lease_seconds),
        ).fetchone()
        return str(found[0]) if found else None

    def finish_run(self, run_id: str, r: Result) -> None:
        confirmed = sum(n for (q, _), n in r.quality.items() if q == "confirmed")
        unverifiable = sum(n for (q, _), n in r.quality.items() if q == "unverifiable")
        self.conn.execute(
            "UPDATE match_runs SET status = 'completed', confirmed = %s, unverifiable = %s, resolved = %s, "
            "unchanged = %s, unmatchable = %s, claimed_until = NULL, updated_at = now() WHERE id = %s",
            (confirmed, unverifiable, r.resolved, r.unchanged, r.unmatchable, run_id),
        )

    def fail_run(self, run_id: str, error: str) -> None:
        self.conn.execute(
            "UPDATE match_runs SET status = 'failed', error = %s, claimed_until = NULL, updated_at = now() "
            "WHERE id = %s",
            (error[:500], run_id),
        )

    # -- reverse: advisories changed since the watermark -------------------------------------------

    def advisory_high_water(self) -> datetime | None:
        row = self.conn.execute("SELECT max(updated_at) FROM vulnerabilities").fetchone()
        return row[0] if row else None

    def watermark(self) -> datetime | None:
        row = self.conn.execute("SELECT watermark FROM correlation_state WHERE name = %s", (WATERMARK,)).fetchone()
        return row[0] if row else None

    def set_watermark(self, value: datetime) -> None:
        self.conn.execute(
            "INSERT INTO correlation_state (name, watermark) VALUES (%s, %s) "
            "ON CONFLICT (name) DO UPDATE SET watermark = EXCLUDED.watermark, updated_at = now()",
            (WATERMARK, value),
        )

    def projects_affected_by(self, after: datetime | None, upto: datetime, overlap_seconds: int) -> list[str]:
        """Projects whose latest import has a package named by an advisory changed in (after - overlap, upto],
        plus projects that hold an open finding for such an advisory (the package may have left the advisory)."""
        return [
            r[0]
            for r in self.conn.execute(
                """
                WITH changed AS (
                  SELECT v.id FROM vulnerabilities v
                  WHERE v.updated_at <= %(upto)s
                    AND (%(after)s::timestamptz IS NULL
                         OR v.updated_at > %(after)s::timestamptz - make_interval(secs => %(overlap)s))
                ), names AS (
                  SELECT DISTINCT a.ecosystem, a.match_name
                  FROM vulnerability_affected a JOIN changed c ON c.id = a.vulnerability_id
                ), hits AS (
                  SELECT DISTINCT d.project_id, d.import_id
                  FROM names n JOIN sbom_dependencies d ON d.ecosystem = n.ecosystem AND d.match_name = n.match_name
                )
                SELECT h.project_id::text FROM hits h
                WHERE h.import_id = (SELECT i.id FROM sbom_imports i WHERE i.project_id = h.project_id
                                     AND i.status = 'parsed' ORDER BY i.created_at DESC, i.id DESC LIMIT 1)
                UNION
                SELECT f.project_id::text FROM findings f JOIN changed c ON c.id = f.vulnerability_id
                WHERE f.status = 'open'
                """,
                {"after": after, "upto": upto, "overlap": overlap_seconds},
            )
        ]

    # -- sweep -------------------------------------------------------------------------------------

    def last_sweep(self) -> datetime | None:
        row = self.conn.execute("SELECT watermark FROM correlation_state WHERE name = %s", (SWEEP,)).fetchone()
        return row[0] if row else None

    def claim_sweep(self, interval_seconds: int, lease_seconds: int) -> bool:
        """True when a sweep is due and this worker now holds its lease."""
        self.conn.execute("INSERT INTO correlation_state (name) VALUES (%s) ON CONFLICT DO NOTHING", (SWEEP,))
        row = self.conn.execute(
            "UPDATE correlation_state SET claimed_until = now() + make_interval(secs => %s), updated_at = now() "
            "WHERE name = %s AND (claimed_until IS NULL OR claimed_until < now()) "
            "AND (watermark IS NULL OR watermark <= now() - make_interval(secs => %s)) RETURNING name",
            (lease_seconds, SWEEP, interval_seconds),
        ).fetchone()
        return row is not None

    def renew_sweep(self, lease_seconds: int) -> bool:
        row = self.conn.execute(
            "UPDATE correlation_state SET claimed_until = now() + make_interval(secs => %s) "
            "WHERE name = %s AND claimed_until >= now() RETURNING name",
            (lease_seconds, SWEEP),
        ).fetchone()
        return row is not None

    def finish_sweep(self, started: datetime) -> None:
        self.conn.execute(
            "UPDATE correlation_state SET watermark = %s, claimed_until = NULL, updated_at = now() WHERE name = %s",
            (started, SWEEP),
        )

    def release_sweep(self) -> None:
        self.conn.execute("UPDATE correlation_state SET claimed_until = NULL WHERE name = %s", (SWEEP,))

    def now(self) -> datetime:
        return self.conn.execute("SELECT clock_timestamp()").fetchone()[0]  # type: ignore[index]

    def project_page(self, after: str | None, limit: int) -> list[str]:
        """Projects that have a parsed import, or open findings to resolve, in id order after `after`."""
        return [
            r[0]
            for r in self.conn.execute(
                """
                SELECT p::text FROM (
                  (SELECT DISTINCT project_id AS p FROM sbom_imports
                   WHERE status = 'parsed' AND (%(after)s::uuid IS NULL OR project_id > %(after)s::uuid)
                   ORDER BY project_id LIMIT %(n)s)
                  UNION
                  (SELECT DISTINCT project_id FROM findings
                   WHERE status = 'open' AND (%(after)s::uuid IS NULL OR project_id > %(after)s::uuid)
                   ORDER BY project_id LIMIT %(n)s)
                ) s ORDER BY p LIMIT %(n)s
                """,
                {"after": after, "n": limit},
            )
        ]
