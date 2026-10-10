"""Requests every configured source on its interval and tracks the runs (SENTRA-10).

    python -m crawler.scheduler        (or `task crawler:scheduler`)

Each pass, in order: expire requests nobody claimed, then for every schedule (one transaction, serialised
by that schedule's row in scheduler_leases) fire the tick if it is due and re-request transient failures
that are due, then publish the new requests. The scheduler only ever emits signed `crawl.requested` events,
so any other orchestrator that does the same can replace it.

Retries read the failure from ingestion_runs (`failure_kind`), not from the crawl.failed event: the table is
written in the same step as the event, survives a scheduler outage, and needs no consumer group.
All time comparisons use the database clock, so replicas with skewed clocks agree.
"""

import logging
import signal
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg
from confluent_kafka import Producer
from prometheus_client import start_http_server

from . import config, log, request
from .config import Schedule, SchedulerSettings
from .metrics import (
    SCHEDULER_ACTIVE_RUNS,
    SCHEDULER_ERRORS,
    SCHEDULER_FAILURES,
    SCHEDULER_LAST_SUCCESS,
    SCHEDULER_REQUESTS,
    SCHEDULER_RETRIES,
    SCHEDULER_TICKS_SKIPPED,
)

logger = logging.getLogger("crawler")

ACTIVE_STATUSES = ["requested", "fetching", "stored"]
# Seconds to wait after a failure before retry 1, 2 and 3 of a failure chain. Assumed; validate against real
# upstream failure modes. After the last retry the chain stops and the next scheduled tick starts afresh.
RETRY_DELAYS = [60, 300, 900]
# A failure older than this is not retried, so a scheduler that was down does not fire a burst of retries.
RETRY_WINDOW_SECONDS = 3600
CONNECT_TIMEOUT_SECONDS = 10

# Failed runs the scheduler may retry for one source + ecosystem: the newest attempt of its chain, with
# retries left, whose delay has passed. `root` is the first run of the chain.
_RETRY_CANDIDATES = """
SELECT root::text FROM (
  SELECT f.created_at, f.completed_at, COALESCE(f.retry_of, f.run_id) AS root,
         (SELECT count(*) FROM ingestion_runs c WHERE c.retry_of = COALESCE(f.retry_of, f.run_id)) AS retries
  FROM ingestion_runs f
  WHERE f.source = %(source)s AND f.ecosystem = %(ecosystem)s AND f.status = 'failed'
    AND f.failure_kind IN ('transient', 'expired') AND f.trigger <> 'manual'
    AND f.completed_at > now() - make_interval(secs => %(window)s)
) x
WHERE retries < %(max_retries)s
  AND completed_at + make_interval(secs => (%(delays)s::int[])[retries + 1]) <= now()
  AND NOT EXISTS (SELECT 1 FROM ingestion_runs n WHERE n.retry_of = x.root AND n.created_at > x.created_at)
ORDER BY completed_at
"""

# Retryable failures that just used up their chain's last retry.
_EXHAUSTED_CHAINS = """
SELECT f.run_id::text, f.source, f.ecosystem FROM ingestion_runs f
WHERE f.status = 'failed' AND f.failure_kind IN ('transient', 'expired') AND f.trigger = 'retry'
  AND f.completed_at > %s AND f.completed_at <= %s
  AND (SELECT count(*) FROM ingestion_runs c WHERE c.retry_of = f.retry_of) >= %s
"""

_FAIL_REQUEST = (
    "UPDATE ingestion_runs SET status = 'failed', failure_kind = %s, error = %s, completed_at = now(), "
    "updated_at = now() WHERE run_id = %s AND status = 'requested'"
)


@dataclass(frozen=True)
class NewRun:
    run_id: str
    correlation_id: str
    trigger: str


class Scheduler:
    def __init__(self, settings: SchedulerSettings, publish: Callable[[dict[str, Any]], None]):
        self.settings = settings
        self._publish = publish
        self._failures_seen_until: datetime | None = None

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.run_once()
            except Exception as e:  # noqa: BLE001 - a failed pass (database down, ...) is retried on the next tick
                SCHEDULER_ERRORS.inc()
                logger.error("scheduler pass failed", extra={"reason": f"{type(e).__name__}: {e}"[:300]})
            stop.wait(self.settings.tick_seconds)

    def run_once(self) -> None:
        with psycopg.connect(
            self.settings.database_url, autocommit=True, connect_timeout=CONNECT_TIMEOUT_SECONDS
        ) as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO scheduler_leases (name) VALUES (%s) ON CONFLICT DO NOTHING",
                    [(s.name,) for s in self.settings.schedules],
                )
            self._expire(conn)
            for schedule in self.settings.schedules:
                for run in self._plan(conn, schedule):
                    self._send(conn, schedule, run)
            self._record_state(conn)

    def _expire(self, conn: psycopg.Connection) -> None:
        """Frees the slot of a run that is not progressing, and marks it for retry. Covers a request nobody
        claimed (message lost, scheduler crashed before publishing) and a claimed run whose worker died: its
        redelivery is skipped while the lease is live, so nothing else would ever close it. A worker that
        resumes such a run later finds it closed and skips it."""
        seconds = self.settings.expiry_seconds
        expired = conn.execute(
            "UPDATE ingestion_runs SET status = 'failed', failure_kind = 'expired', error = %s, "
            "completed_at = now(), updated_at = now() WHERE "
            "(status = 'requested' AND created_at < now() - make_interval(secs => %s)) "
            "OR (status IN ('fetching', 'stored') "
            "AND COALESCE(claimed_until, updated_at) < now() - make_interval(secs => %s)) "
            "RETURNING run_id::text, source, ecosystem, correlation_id",
            (f"no progress within {seconds}s (request unclaimed or worker lost)", seconds, seconds),
        ).fetchall()
        for run_id, source, ecosystem, correlation_id in expired:
            logger.warning(
                "run expired without progress",
                extra={"runId": run_id, "correlationId": correlation_id, "source": source, "ecosystem": ecosystem},
            )

    def _plan(self, conn: psycopg.Connection, schedule: Schedule) -> list[NewRun]:
        """Record the runs to request for one schedule. The row lock makes the due check, the cap check and the
        inserts one step, so replicas never double-request and the cap holds. Nothing is published in here."""
        runs: list[NewRun] = []
        with conn.transaction():
            row = conn.execute(
                "SELECT next_due_at <= now() FROM scheduler_leases WHERE name = %s FOR UPDATE", (schedule.name,)
            ).fetchone()
            if row and row[0]:
                conn.execute(
                    "UPDATE scheduler_leases SET next_due_at = now() + make_interval(secs => %s) WHERE name = %s",
                    (schedule.interval_seconds, schedule.name),
                )
                if run := self._insert(conn, schedule, "schedule", None):
                    runs.append(run)
                else:
                    SCHEDULER_TICKS_SKIPPED.labels(schedule.source, schedule.ecosystem, "cap").inc()
                    logger.warning(
                        "tick skipped: source is at its cap of active runs",
                        extra={"source": schedule.source, "ecosystem": schedule.ecosystem, "trigger": "schedule"},
                    )
            candidates = conn.execute(
                _RETRY_CANDIDATES,
                {
                    "source": schedule.source,
                    "ecosystem": schedule.ecosystem,
                    "window": RETRY_WINDOW_SECONDS,
                    "max_retries": len(RETRY_DELAYS),
                    "delays": RETRY_DELAYS,
                },
            ).fetchall()
            for (root,) in candidates:
                run = self._insert(conn, schedule, "retry", root)
                if run is None:  # at the cap: still due on the next pass
                    SCHEDULER_TICKS_SKIPPED.labels(schedule.source, schedule.ecosystem, "retry_cap").inc()
                    logger.warning(
                        "retry deferred: source is at its cap of active runs",
                        extra={"source": schedule.source, "ecosystem": schedule.ecosystem, "trigger": "retry"},
                    )
                    break
                runs.append(run)
        return runs

    def _insert(self, conn: psycopg.Connection, s: Schedule, trigger: str, retry_of: str | None) -> NewRun | None:
        (active,) = conn.execute(
            "SELECT count(*) FROM ingestion_runs WHERE source = %s AND ecosystem = %s AND status = ANY(%s)",
            (s.source, s.ecosystem, ACTIVE_STATUSES),
        ).fetchone() or (0,)
        if active >= self.settings.max_active_runs:
            return None
        run_id = str(uuid.uuid4())
        run = NewRun(run_id, f"{trigger}-{run_id[:8]}", trigger)
        conn.execute(
            "INSERT INTO ingestion_runs (run_id, source, ecosystem, status, correlation_id, trigger, retry_of) "
            "VALUES (%s, %s, %s, 'requested', %s, %s, %s)",
            (run_id, s.source, s.ecosystem, run.correlation_id, trigger, retry_of),
        )
        return run

    def _send(self, conn: psycopg.Connection, s: Schedule, run: NewRun) -> None:
        extra = {
            "runId": run.run_id,
            "correlationId": run.correlation_id,
            "source": s.source,
            "ecosystem": s.ecosystem,
            "trigger": run.trigger,
        }
        event = request.build(
            s.source, s.ecosystem, self.settings.signing_keys, run_id=run.run_id, correlation_id=run.correlation_id
        )
        try:
            self._publish(event)
        except Exception as e:  # noqa: BLE001 - whatever went wrong, the row must not stay `requested`
            reason = f"publish failed: {type(e).__name__}"
            conn.execute(_FAIL_REQUEST, ("transient", reason, run.run_id))
            logger.error("could not publish request", extra={**extra, "reason": reason})
            return
        SCHEDULER_REQUESTS.labels(s.source, run.trigger).inc()
        if run.trigger == "retry":
            SCHEDULER_RETRIES.labels(s.source).inc()
        logger.info("crawl requested", extra=extra)

    def _record_state(self, conn: psycopg.Connection) -> None:
        active = {
            (source, ecosystem): count
            for source, ecosystem, count in conn.execute(
                "SELECT source, ecosystem, count(*) FROM ingestion_runs WHERE status = ANY(%s) "
                "GROUP BY source, ecosystem",
                (ACTIVE_STATUSES,),
            )
        }
        for s in self.settings.schedules:
            SCHEDULER_ACTIVE_RUNS.labels(s.source, s.ecosystem).set(active.get((s.source, s.ecosystem), 0))
        for source, ecosystem, finished in conn.execute(
            "SELECT source, ecosystem, extract(epoch FROM max(completed_at)) FROM ingestion_runs "
            "WHERE status IN ('published', 'unchanged') GROUP BY source, ecosystem"
        ):
            SCHEDULER_LAST_SUCCESS.labels(source, ecosystem).set(float(finished))

        (now,) = conn.execute("SELECT now()").fetchone() or (None,)
        if self._failures_seen_until is not None:
            for source, kind, count in conn.execute(
                "SELECT source, COALESCE(failure_kind, 'unknown'), count(*) FROM ingestion_runs "
                "WHERE status = 'failed' AND completed_at > %s AND completed_at <= %s GROUP BY 1, 2",
                (self._failures_seen_until, now),
            ):
                SCHEDULER_FAILURES.labels(source, kind).inc(count)
            for run_id, source, ecosystem in conn.execute(
                _EXHAUSTED_CHAINS, (self._failures_seen_until, now, len(RETRY_DELAYS))
            ):
                logger.info(
                    "retry chain exhausted; waiting for the next tick",
                    extra={"runId": run_id, "source": source, "ecosystem": ecosystem},
                )
        self._failures_seen_until = now


def main() -> int:
    log.setup()
    if not config.scheduler_enabled():
        logger.info("scheduler disabled by SCHEDULER_ENABLED=false; nothing will be requested")
        return 0
    settings = config.load_scheduler()
    producer = Producer({"bootstrap.servers": settings.kafka_bootstrap, "enable.idempotence": True, "acks": "all"})
    scheduler = Scheduler(settings, lambda event: request.publish(producer, event))
    start_http_server(settings.metrics_port, addr=settings.metrics_host)
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    logger.info(f"scheduler starting with {len(settings.schedules)} schedules")
    scheduler.run(stop)
    logger.info("scheduler stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
