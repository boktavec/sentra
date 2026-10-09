"""Only the investigation table is visible to the worker's database role."""

from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import psycopg

LOCK_KEY = 734178


@dataclass(frozen=True)
class Run:
    id: str
    org_id: str
    model_id: str
    context: dict[str, Any]
    attempts: int
    lease_owner: str


class Store:
    def __init__(self, url: str):
        self._url = url
        self._conn: psycopg.Connection[Any] | None = None
        self._slot: int | None = None

    @property
    def conn(self) -> psycopg.Connection[Any]:
        if self._conn is None or self._conn.closed or self._conn.broken:
            self._conn = psycopg.connect(self._url, autocommit=True)
        return self._conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()

    def acquire_slot(self, count: int) -> bool:
        for slot in range(count):
            row = self.conn.execute("SELECT pg_try_advisory_lock(%s, %s)", (LOCK_KEY, slot)).fetchone()
            if row and row[0]:
                self._slot = slot
                return True
        return False

    def release_slot(self) -> None:
        if self._slot is not None:
            self.conn.execute("SELECT pg_advisory_unlock(%s, %s)", (LOCK_KEY, self._slot))
            self._slot = None

    def claim(self, lease_seconds: int, max_attempts: int) -> Run | None:
        # A crash can consume an attempt without reaching fail(). Retire expired
        # leases before selecting work so restarts cannot retry forever.
        self.conn.execute(
            """UPDATE investigations SET status = 'failed', failure_code = 'attempts_exhausted',
                 lease_owner = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
               WHERE attempts >= %s AND ((status = 'running' AND lease_expires_at < now())
                    OR (status = 'queued' AND next_attempt_at <= now()))""",
            (max_attempts,),
        )
        owner = str(uuid4())
        row = self.conn.execute(
            """UPDATE investigations i SET status = 'running', attempts = attempts + 1,
                 lease_owner = %s, lease_expires_at = now() + make_interval(secs => %s),
                 started_at = coalesce(started_at, now()), updated_at = now()
               WHERE id = (SELECT id FROM investigations
                 WHERE (status = 'queued' AND next_attempt_at <= now() AND attempts < %s)
                    OR (status = 'running' AND lease_expires_at < now() AND attempts < %s)
                 ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
               RETURNING i.id::text, i.org_id::text, i.model_id, i.context_snapshot, i.attempts""",
            (owner, lease_seconds, max_attempts, max_attempts),
        ).fetchone()
        return Run(str(row[0]), str(row[1]), row[2], row[3], row[4], owner) if row else None

    def complete(self, run: Run, draft: str) -> bool:
        row = self.conn.execute(
            """UPDATE investigations SET status = 'completed', draft = %s, failure_code = NULL,
                 lease_owner = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
               WHERE id = %s AND org_id = %s AND status = 'running' AND lease_owner = %s
               RETURNING id""",
            (draft, run.id, run.org_id, run.lease_owner),
        ).fetchone()
        return row is not None

    def fail(self, run: Run, code: str, retryable: bool, max_attempts: int) -> str:
        if retryable and run.attempts < max_attempts:
            delay = min(5 * 2 ** (run.attempts - 1), 300)
            target = "queued"
            self.conn.execute(
                """UPDATE investigations SET status = 'queued', failure_code = NULL,
                     next_attempt_at = now() + make_interval(secs => %s),
                     lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
                   WHERE id = %s AND org_id = %s AND status = 'running' AND lease_owner = %s""",
                (delay, run.id, run.org_id, run.lease_owner),
            )
        else:
            target = "failed"
            self.conn.execute(
                """UPDATE investigations SET status = 'failed', failure_code = %s,
                     lease_owner = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
                   WHERE id = %s AND org_id = %s AND status = 'running' AND lease_owner = %s""",
                (code, run.id, run.org_id, run.lease_owner),
            )
        return target

    def queue_age_seconds(self) -> float:
        row = self.conn.execute(
            "SELECT extract(epoch FROM now() - min(created_at))::float FROM investigations WHERE status = 'queued'"
        ).fetchone()
        return float(row[0] or 0) if row else 0.0
