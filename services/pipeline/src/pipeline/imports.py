from dataclasses import dataclass

import psycopg
from psycopg.rows import class_row


@dataclass(frozen=True)
class Import:
    id: str
    status: str
    object_key: str


class Imports:
    """sbom_imports access as the sentra_pipeline role: read, and set only the validation result.

    Autocommit: each statement is its own atomic step. The connection is re-opened on the next call
    after it breaks, so a Postgres restart is a few retried events, not a dead service.
    """

    def __init__(self, database_url: str):
        self.database_url = database_url
        self._conn: psycopg.Connection | None = None

    @property
    def conn(self) -> psycopg.Connection:
        if self._conn is None or self._conn.closed or self._conn.broken:
            self._conn = psycopg.connect(self.database_url, autocommit=True)
        return self._conn

    def get(self, import_id: str) -> Import | None:
        with self.conn.cursor(row_factory=class_row(Import)) as cur:
            cur.execute("SELECT id::text, status, object_key FROM sbom_imports WHERE id = %s", (import_id,))
            return cur.fetchone()

    def finish(self, import_id: str, *, status: str, reason: str | None, size: int | None, sha256: str | None) -> bool:
        """Record the result. False means the import was no longer `uploaded` (a duplicate delivery)."""
        cur = self.conn.execute(
            "UPDATE sbom_imports SET status = %s, reason_code = %s, size_bytes = %s, sha256 = %s, updated_at = now() "
            "WHERE id = %s AND status = 'uploaded'",
            (status, reason, size, sha256, import_id),
        )
        return cur.rowcount == 1

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
