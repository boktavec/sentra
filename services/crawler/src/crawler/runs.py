from dataclasses import dataclass
from datetime import datetime

import psycopg
from psycopg import sql
from psycopg.rows import class_row


@dataclass(frozen=True)
class Run:
    run_id: str
    source: str
    ecosystem: str
    status: str
    artifact_key: str | None
    sha256: str | None
    etag: str | None
    size_bytes: int | None
    attempts: int
    correlation_id: str
    watermark: datetime | None  # newest upstream modification time this run covered (incremental sources)


_COLUMNS = (
    "run_id::text, source, ecosystem, status, artifact_key, sha256, etag, size_bytes, attempts, correlation_id, "
    "watermark"
)


TERMINAL = ("published", "unchanged", "failed")


class Runs:
    """ingestion_runs access. Autocommit: every statement is its own atomic step."""

    def __init__(self, database_url: str):
        self._url = database_url
        self._conn = psycopg.connect(database_url, autocommit=True)

    @classmethod
    def connect(cls, database_url: str) -> Runs:
        return cls(database_url)

    @property
    def conn(self) -> psycopg.Connection:
        """The connection, replaced if it died (restart, failover, idle kill). The call that hit the dead
        connection still fails and is retried by the worker; the next one uses a fresh connection."""
        if self._conn.closed or self._conn.broken:
            try:
                self._conn.close()
            except psycopg.Error:
                pass
            self._conn = psycopg.connect(self._url, autocommit=True)
        return self._conn

    def claim(self, run_id: str, source: str, ecosystem: str, correlation_id: str, lease_seconds: int) -> Run | None:
        """Create the run if new (a manual request), then take a lease on it. A run the scheduler recorded as
        `requested` moves to `fetching` here. None means: already finished or expired, or another worker holds
        a live lease. Redelivered requests therefore resolve to the same row."""
        with self.conn.cursor(row_factory=class_row(Run)) as cur:
            cur.execute(
                "INSERT INTO ingestion_runs (run_id, source, ecosystem, correlation_id) VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (run_id) DO NOTHING",
                (run_id, source, ecosystem, correlation_id),
            )
            cur.execute(
                f"UPDATE ingestion_runs SET claimed_until = now() + make_interval(secs => %s), updated_at = now(), "
                f"status = CASE WHEN status = 'requested' THEN 'fetching' ELSE status END, "
                f"started_at = COALESCE(started_at, now()) "
                f"WHERE run_id = %s AND source = %s AND ecosystem = %s "
                f"AND status IN ('requested', 'fetching', 'stored') "
                f"AND (claimed_until IS NULL OR claimed_until < now()) RETURNING {_COLUMNS}",
                (lease_seconds, run_id, source, ecosystem),
            )
            return cur.fetchone()

    def latest_published(self, source: str, ecosystem: str) -> Run | None:
        """The newest run that handed an artifact to the pipeline (or confirmed it unchanged)."""
        with self.conn.cursor(row_factory=class_row(Run)) as cur:
            cur.execute(
                f"SELECT {_COLUMNS} FROM ingestion_runs WHERE source = %s AND ecosystem = %s "
                f"AND status IN ('published', 'unchanged') AND sha256 IS NOT NULL "
                f"ORDER BY created_at DESC LIMIT 1",
                (source, ecosystem),
            )
            return cur.fetchone()

    def _set(self, run_id: str, status: str, frm: tuple[str, ...], **fields: object) -> None:
        # Field names come from the mark_* methods below (never from input); values are bound parameters.
        assignments = sql.SQL(", ").join(sql.SQL("{} = %s").format(sql.Identifier(k)) for k in fields)
        completed = sql.SQL("completed_at = now(), ") if status in TERMINAL else sql.SQL("")
        query = sql.SQL(
            "UPDATE ingestion_runs SET status = %s, {}{}"
            "claimed_until = CASE WHEN %s = 'stored' THEN claimed_until ELSE NULL END, "
            "updated_at = now() WHERE run_id = %s AND status = ANY(%s)"
        ).format(assignments + sql.SQL(", ") if fields else sql.SQL(""), completed)
        cur = self.conn.execute(query, (status, *fields.values(), status, run_id, list(frm)))
        if cur.rowcount != 1:
            raise RuntimeError(f"run {run_id}: cannot move to {status} (unexpected current state)")

    def mark_stored(
        self,
        run_id: str,
        key: str,
        sha256: str,
        etag: str | None,
        size: int,
        attempts: int,
        watermark: datetime | None = None,
    ) -> None:
        # Stays leased: the same worker publishes next. Terminal states release the lease.
        self._set(
            run_id,
            "stored",
            ("fetching",),
            artifact_key=key,
            sha256=sha256,
            etag=etag,
            size_bytes=size,
            attempts=attempts,
            watermark=watermark,
        )

    def mark_unchanged(
        self,
        run_id: str,
        etag: str | None,
        sha256: str | None,
        size: int | None,
        attempts: int,
        watermark: datetime | None = None,
    ) -> None:
        self._set(
            run_id,
            "unchanged",
            ("fetching",),
            etag=etag,
            sha256=sha256,
            size_bytes=size,
            attempts=attempts,
            watermark=watermark,
        )

    def mark_published(self, run_id: str) -> None:
        self._set(run_id, "published", ("stored",))

    def mark_failed(self, run_id: str, error: str, attempts: int, failure_kind: str) -> None:
        self._set(
            run_id,
            "failed",
            ("requested", "fetching", "stored"),
            error=error[:500],
            attempts=attempts,
            failure_kind=failure_kind,
        )

    def release(self, run_id: str) -> None:
        """Drop the lease on a run that stays open so a redelivery can resume it immediately."""
        self.conn.execute(
            "UPDATE ingestion_runs SET claimed_until = NULL, updated_at = now() "
            "WHERE run_id = %s AND status IN ('fetching', 'stored')",
            (run_id,),
        )
