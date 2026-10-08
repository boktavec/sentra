import uuid
from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

# Records are (zip entry name, canonical vulnerability document).
Record = tuple[str, dict[str, Any]]
Failure = tuple[str, str]  # (zip entry name, error)


class LeaseLost(Exception):
    """Another worker took over this run; nothing from this batch was written."""


@dataclass(frozen=True)
class Claim:
    state: str  # claimed | completed | published | busy
    run_id: str


@dataclass(frozen=True)
class RunRow:
    run_id: str
    status: str
    upserted: int
    unchanged: int
    quarantined: int
    correlation_id: str


# Written only when the source says the advisory changed or a newer adapter produced it, so reprocessing
# the same artifact rewrites nothing. RETURNING is empty for a skipped row.
UPSERT = """
INSERT INTO vulnerabilities
  (source, source_id, aliases, summary, details, published_at, modified_at, withdrawn_at, severity, refs,
   source_artifact_sha256, source_entry, schema_version, adapter_version)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (source, source_id) DO UPDATE SET
  aliases = EXCLUDED.aliases, summary = EXCLUDED.summary, details = EXCLUDED.details,
  published_at = EXCLUDED.published_at, modified_at = EXCLUDED.modified_at,
  withdrawn_at = EXCLUDED.withdrawn_at, severity = EXCLUDED.severity, refs = EXCLUDED.refs,
  source_artifact_sha256 = EXCLUDED.source_artifact_sha256, source_entry = EXCLUDED.source_entry,
  schema_version = EXCLUDED.schema_version, adapter_version = EXCLUDED.adapter_version, updated_at = now()
WHERE EXCLUDED.modified_at > vulnerabilities.modified_at
   OR EXCLUDED.adapter_version > vulnerabilities.adapter_version
RETURNING id
"""


class Store:
    """Vulnerability and run-state access as the sentra_normalizer role.

    Autocommit: each statement is its own step, and a batch is one explicit transaction. The connection
    is re-opened on the next call after it breaks, so a Postgres restart is a few retried events.
    """

    def __init__(self, database_url: str):
        self.database_url = database_url
        self._conn: psycopg.Connection | None = None

    @property
    def conn(self) -> psycopg.Connection:
        if self._conn is None or self._conn.closed or self._conn.broken:
            self._conn = psycopg.connect(self.database_url, autocommit=True)
        return self._conn

    def claim(
        self, *, sha256: str, source: str, ecosystem: str, adapter_version: int, correlation_id: str, lease_seconds: int
    ) -> Claim:
        """Take the run for this artifact and adapter version, or say why not.

        `completed` means the records are committed but the event may not have been sent; `published`
        means there is nothing left to do; `busy` means another worker holds a live lease.
        """
        inserted = self.conn.execute(
            "INSERT INTO normalization_runs (artifact_sha256, source, ecosystem, adapter_version, correlation_id, "
            "claimed_until) VALUES (%s, %s, %s, %s, %s, now() + make_interval(secs => %s)) "
            "ON CONFLICT (artifact_sha256, adapter_version) DO NOTHING RETURNING id::text",
            (sha256, source, ecosystem, adapter_version, correlation_id, lease_seconds),
        ).fetchone()
        if inserted:
            return Claim("claimed", inserted[0])
        row = self.conn.execute(
            "SELECT id::text, status, claimed_until IS NULL OR claimed_until < now() FROM normalization_runs "
            "WHERE artifact_sha256 = %s AND adapter_version = %s",
            (sha256, adapter_version),
        ).fetchone()
        if row is None:  # runs are never deleted, so this is a bug
            raise RuntimeError("normalization run vanished")
        run_id, status, expired = row
        if status in ("completed", "published"):
            return Claim(status, run_id)
        if status == "running" and not expired:
            return Claim("busy", run_id)
        # failed, or running with an expired lease: retake it. The status guard lets only one worker win.
        taken = self.conn.execute(
            "UPDATE normalization_runs SET status = 'running', upserted = 0, unchanged = 0, quarantined = 0, "
            "error = NULL, correlation_id = %s, claimed_until = now() + make_interval(secs => %s), "
            "updated_at = now() WHERE id = %s AND status = %s AND (status <> 'running' OR claimed_until < now())",
            (correlation_id, lease_seconds, run_id, status),
        )
        return Claim("claimed" if taken.rowcount == 1 else "busy", run_id)

    def restart(self, run_id: str, lease_seconds: int) -> None:
        """Zero the counters before another pass over the artifact (an earlier attempt failed part way)."""
        self.conn.execute(
            "UPDATE normalization_runs SET upserted = 0, unchanged = 0, quarantined = 0, "
            "claimed_until = now() + make_interval(secs => %s), updated_at = now() "
            "WHERE id = %s AND status = 'running'",
            (lease_seconds, run_id),
        )

    def commit_batch(
        self,
        run_id: str,
        *,
        sha256: str,
        adapter_version: int,
        schema_version: int,
        ok: list[Record],
        failed: list[Failure],
        lease_seconds: int,
    ) -> tuple[int, int]:
        """Write one batch and move the run's counters and lease, all in one transaction.

        Returns (upserted, unchanged). Raises LeaseLost, having written nothing, if the run was retaken.
        """
        with self.conn.transaction():
            changed: list[tuple[str, dict[str, Any]]] = []
            if ok:
                with self.conn.cursor() as cur:
                    cur.executemany(
                        UPSERT,
                        [
                            (
                                d["source"],
                                d["sourceId"],
                                d["aliases"],
                                d["summary"],
                                d["details"],
                                d["publishedAt"],
                                d["modifiedAt"],
                                d["withdrawnAt"],
                                Jsonb(d["severity"]),
                                Jsonb(d["references"]),
                                sha256,
                                name,
                                schema_version,
                                adapter_version,
                            )
                            for name, d in ok
                        ],
                        returning=True,
                    )
                    for _, doc in ok:
                        row = cur.fetchone()
                        if row:
                            changed.append((row[0], doc))
                        cur.nextset()
            self._replace_affected(changed)
            if failed:
                with self.conn.cursor() as cur:
                    cur.executemany(
                        "INSERT INTO normalization_failures (artifact_sha256, entry_name, adapter_version, error) "
                        "VALUES (%s, %s, %s, %s) ON CONFLICT (artifact_sha256, entry_name, adapter_version) "
                        "DO UPDATE SET error = EXCLUDED.error, created_at = now()",
                        [(sha256, name, adapter_version, error) for name, error in failed],
                    )
            moved = self.conn.execute(
                "UPDATE normalization_runs SET upserted = upserted + %s, unchanged = unchanged + %s, "
                "quarantined = quarantined + %s, claimed_until = now() + make_interval(secs => %s), "
                "updated_at = now() WHERE id = %s AND status = 'running'",
                (len(changed), len(ok) - len(changed), len(failed), lease_seconds, run_id),
            )
            if moved.rowcount != 1:
                raise LeaseLost(run_id)
        return len(changed), len(ok) - len(changed)

    def _replace_affected(self, changed: list[tuple[str, dict[str, Any]]]) -> None:
        if not changed:
            return
        # Ranges go with their affected row (ON DELETE CASCADE).
        self.conn.execute(
            "DELETE FROM vulnerability_affected WHERE vulnerability_id = ANY(%s)", ([c[0] for c in changed],)
        )
        affected, ranges = [], []
        for vulnerability_id, doc in changed:
            for a in doc["affected"]:
                affected_id = uuid.uuid4()
                affected.append(
                    (affected_id, vulnerability_id, a["ecosystem"], a["packageName"], a["purl"], a["versions"])
                )
                for ri, r in enumerate(a["ranges"]):
                    for ei, e in enumerate(r["events"]):
                        ranges.append((affected_id, ri, ei, r["type"], e["type"], e["version"]))
        with self.conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO vulnerability_affected (id, vulnerability_id, ecosystem, package_name, purl, versions) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                affected,
            )
            cur.executemany(
                "INSERT INTO vulnerability_ranges (affected_id, range_index, event_index, range_type, event_type, "
                "event_version) VALUES (%s, %s, %s, %s, %s, %s)",
                ranges,
            )

    def finish(self, run_id: str, *, status: str, error: str | None = None) -> bool:
        """Move a running run to completed or failed. False means it was no longer ours."""
        done = self.conn.execute(
            "UPDATE normalization_runs SET status = %s, error = %s, claimed_until = NULL, updated_at = now() "
            "WHERE id = %s AND status = 'running'",
            (status, error, run_id),
        )
        return done.rowcount == 1

    def mark_published(self, run_id: str) -> None:
        self.conn.execute(
            "UPDATE normalization_runs SET status = 'published', updated_at = now() "
            "WHERE id = %s AND status = 'completed'",
            (run_id,),
        )

    def run(self, run_id: str) -> RunRow:
        row = self.conn.execute(
            "SELECT id::text, status, upserted, unchanged, quarantined, correlation_id FROM normalization_runs "
            "WHERE id = %s",
            (run_id,),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"normalization run {run_id} not found")
        return RunRow(*row)

    def latest_artifact(self, source: str, ecosystem: str) -> str | None:
        row = self.conn.execute(
            "SELECT artifact_sha256 FROM normalization_runs WHERE source = %s AND ecosystem = %s "
            "ORDER BY created_at DESC LIMIT 1",
            (source, ecosystem),
        ).fetchone()
        return row[0] if row else None

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
