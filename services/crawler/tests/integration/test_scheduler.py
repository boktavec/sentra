"""The scheduler against a real Postgres (as the sentra_scheduler role) and the real crawler claim path.

Kafka is faked at the outermost boundary: `publish` records events instead of producing them, and a test feeds
an event to `handle()` to play the part of the worker. Time is moved by editing timestamps in the database,
because the scheduler reads only the database clock.
"""

import logging
import threading

import psycopg
import pytest
from prometheus_client import REGISTRY

from conftest import KEYS, NPM_SCHEDULE, PYPI_SCHEDULE
from crawler import contracts, signing
from crawler.config import Schedule, SchedulerSettings
from crawler.ingest import handle
from crawler.scheduler import RETRY_DELAYS, RETRY_WINDOW_SECONDS
from fake_osv import Response, make_zip

NPM = "/npm/all.zip"


def sample(name: str, **labels) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


def test_each_schedule_fires_once_per_interval_and_a_restart_does_not_refire(rig):
    rig.settings["schedules"] = [NPM_SCHEDULE, PYPI_SCHEDULE, Schedule("cisa-kev", "none", 21600)]
    before = sample("scheduler_requests_total", source="osv", trigger="schedule")

    rig.tick()
    rig.tick()  # a new instance, as after a restart: the interval has not elapsed

    assert sorted((r["source"], r["ecosystem"], r["status"], r["trigger"]) for r in rig.runs()) == [
        ("cisa-kev", "none", "requested", "schedule"),
        ("osv", "PyPI", "requested", "schedule"),
        ("osv", "npm", "requested", "schedule"),
    ]
    assert len(rig.published) == 3
    for event in rig.published:
        contracts.validate("crawl.requested", event)
        assert signing.verify(event, KEYS)
    assert {e["runId"] for e in rig.published} == {r["run_id"] for r in rig.runs()}
    assert sample("scheduler_requests_total", source="osv", trigger="schedule") - before == 2

    rig.make_due()
    rig.tick()
    assert len(rig.runs()) == 6


def test_a_scheduled_request_is_claimed_and_completed_by_the_worker(rig, harness):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    rig.tick()
    (event,) = rig.published

    assert rig.work(harness, event) == "published"
    assert rig.work(harness, event) == "skipped"  # a redelivery maps to the same row

    (run,) = rig.runs()
    assert (run["run_id"], run["status"], run["trigger"], run["failure_kind"]) == (
        event["runId"],
        "published",
        "schedule",
        None,
    )
    assert run["started_at"] is not None and run["completed_at"] >= run["started_at"]
    assert len(harness.published) == 1 and harness.osv.count(NPM) == 1
    rig.tick()
    assert sample("scheduler_active_runs", source="osv", ecosystem="npm") == 0
    assert sample("scheduler_last_success_timestamp_seconds", source="osv", ecosystem="npm") > 0


def test_concurrent_replicas_request_each_due_tick_exactly_once(rig):
    rig.settings["max_active_runs"] = 100  # the cap is not what is under test here

    def replica(barrier):
        scheduler = rig.scheduler()
        barrier.wait()
        scheduler.run_once()

    for _ in range(5):
        rig.make_due()
        barrier = threading.Barrier(4)
        threads = [threading.Thread(target=replica, args=(barrier,)) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
    assert len(rig.runs()) == 5 and len(rig.published) == 5


def test_the_cap_holds_when_replicas_race_for_the_last_slots(rig):
    def replica(barrier):
        scheduler = rig.scheduler()
        barrier.wait()
        scheduler.run_once()

    for _ in range(4):
        rig.make_due()
        barrier = threading.Barrier(6)
        threads = [threading.Thread(target=replica, args=(barrier,)) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        assert len(rig.runs()) <= 2 and len(rig.runs()) == len(rig.published)
    assert len(rig.runs()) == 2  # cap = 2: filled exactly, never exceeded


def test_a_tick_above_the_cap_is_skipped_logged_and_counted(rig, caplog):
    before = sample("scheduler_ticks_skipped_total", source="osv", ecosystem="npm", reason="cap")
    for _ in range(2):
        rig.make_due()
        rig.tick()
    rig.make_due()
    with caplog.at_level(logging.WARNING, logger="crawler"):
        rig.tick()

    assert len(rig.runs()) == 2 and len(rig.published) == 2  # the cap holds
    assert sample("scheduler_ticks_skipped_total", source="osv", ecosystem="npm", reason="cap") - before == 1
    assert "at its cap" in caplog.text
    assert sample("scheduler_active_runs", source="osv", ecosystem="npm") == 2


def test_the_cap_is_per_source_and_ecosystem(rig):
    rig.settings.update(schedules=[NPM_SCHEDULE, PYPI_SCHEDULE], max_active_runs=1)
    rig.tick()
    rig.make_due()
    rig.tick()
    assert sorted(r["ecosystem"] for r in rig.runs()) == ["PyPI", "npm"]


def test_a_transient_failure_is_retried_on_the_backoff_schedule_then_stops(rig, harness):
    harness.osv.serve(NPM, Response(status=503))
    retries_before = sample("scheduler_retries_total", source="osv")
    rig.tick()
    root = rig.published[0]
    assert rig.work(harness, root) == "failed"
    (first,) = rig.runs()
    assert first["failure_kind"] == "transient"

    chain = [root]
    for n, delay in enumerate(RETRY_DELAYS, start=1):
        rig.tick()
        assert len(rig.published) == n  # not due yet: nothing new
        rig.advance(delay + 1)
        rig.tick()
        assert len(rig.published) == n + 1
        retry = rig.published[-1]
        assert retry["runId"] != chain[-1]["runId"]  # a new run, never a redelivery
        assert rig.work(harness, retry) == "failed"
        chain.append(retry)

    rig.advance(3600 - 1)
    rig.tick()
    assert len(rig.published) == 4  # bounded: 1 original + 3 retries
    runs = rig.runs()
    assert [r["trigger"] for r in runs] == ["schedule", "retry", "retry", "retry"]
    assert {r["retry_of"] for r in runs[1:]} == {root["runId"]}  # every retry points at the chain's first run
    assert sample("scheduler_retries_total", source="osv") - retries_before == 3


def test_failures_are_counted_by_kind_as_the_scheduler_observes_them(rig, harness):
    scheduler = rig.scheduler()
    scheduler.run_once()  # starts observing; it fires the first request
    transient = sample("scheduler_failures_total", source="osv", kind="transient")
    permanent = sample("scheduler_failures_total", source="osv", kind="permanent")

    harness.osv.serve(NPM, Response(status=503))
    assert rig.work(harness, rig.published[0]) == "failed"
    scheduler.run_once()
    scheduler.run_once()  # an already-counted failure is not counted again
    assert sample("scheduler_failures_total", source="osv", kind="transient") - transient == 1

    rig.make_due()
    scheduler.run_once()
    harness.osv.serve(NPM, Response(status=404))
    assert rig.work(harness, rig.published[-1]) == "failed"
    scheduler.run_once()
    assert sample("scheduler_failures_total", source="osv", kind="permanent") - permanent == 1


def test_a_retry_that_succeeds_ends_the_chain_without_duplicating_the_artifact(rig, harness):
    harness.osv.serve(NPM, Response(status=503))
    rig.tick()
    assert rig.work(harness, rig.published[0]) == "failed"
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    rig.advance(RETRY_DELAYS[0] + 1)
    rig.tick()
    assert rig.work(harness, rig.published[1]) == "published"

    rig.advance(10_000)
    rig.tick()
    assert len(rig.published) == 2  # nothing further to retry
    assert [e["type"] for e in harness.published].count("artifact.ingested") == 1
    assert len([k for k in harness.objects() if k.endswith(".zip")]) == 1


def test_a_failure_from_before_an_outage_is_not_retried_in_a_burst(rig, harness):
    harness.osv.serve(NPM, Response(status=503))
    rig.tick()
    assert rig.work(harness, rig.published[0]) == "failed"
    rig.advance(RETRY_WINDOW_SECONDS + 1)  # the scheduler was down for longer than retries stay relevant
    rig.tick()
    assert len(rig.published) == 1


def test_a_permanent_failure_is_never_retried(rig, harness):
    harness.osv.serve(NPM, Response(status=404))
    rig.tick()
    assert rig.work(harness, rig.published[0]) == "failed"
    assert rig.runs()[0]["failure_kind"] == "permanent"
    rig.advance(3000)
    rig.tick()
    assert len(rig.published) == 1


def test_a_failed_manual_run_is_not_retried(rig, harness):
    from conftest import make_request

    harness.osv.serve(NPM, Response(status=503))
    assert handle(make_request(), harness.deps()) == "failed"
    (run,) = rig.runs()
    assert run["trigger"] == "manual" and run["failure_kind"] == "transient"
    rig.advance(600)
    rig.tick()
    assert [r["trigger"] for r in rig.runs()] == ["manual", "schedule"]  # only the tick fired


def test_a_lost_request_expires_frees_its_slot_and_is_retried(rig, harness):
    rig.settings.update(max_active_runs=1, expiry_seconds=900)
    rig.tick()  # published, but the message is lost: no worker ever sees it
    (lost,) = rig.runs()
    rig.make_due()
    rig.tick()
    assert len(rig.runs()) == 1  # at the cap while the lost request still counts as active

    rig.advance(901)
    rig.tick()  # expires it
    expired = rig.runs(run_id=lost["run_id"])[0]
    assert (expired["status"], expired["failure_kind"]) == ("failed", "expired")
    assert "no progress" in expired["error"] and expired["completed_at"] is not None
    rig.make_due()
    rig.tick()  # the slot is free again
    assert [r["trigger"] for r in rig.runs()] == ["schedule", "schedule"]

    # The worker finally sees the stale message: the run is already closed, so nothing is fetched.
    assert rig.work(harness, rig.published[0]) == "skipped"
    assert harness.osv.count(NPM) == 0 and rig.runs(run_id=lost["run_id"])[0]["status"] == "failed"


def test_a_run_whose_worker_died_expires_after_its_lease_lapses_and_frees_the_cap(rig, harness):
    rig.settings.update(max_active_runs=1, expiry_seconds=900)
    rig.tick()
    event = rig.published[0]
    # The worker claims the run and is killed mid-download: no release, no result.
    assert harness.deps().runs.claim(event["runId"], "osv", "npm", event["correlationId"], 1500)
    assert rig.work(harness, event) == "skipped"  # the restarted worker's redelivery backs off and is committed

    rig.make_due()
    rig.tick()
    assert len(rig.published) == 1  # the live lease still holds the only slot

    rig.admin.execute("UPDATE ingestion_runs SET claimed_until = now() - interval '901 seconds'")
    rig.make_due()
    rig.tick()  # expires the dead run, then the tick fits

    dead = rig.runs(run_id=event["runId"])[0]
    assert (dead["status"], dead["failure_kind"]) == ("failed", "expired")
    assert len(rig.published) == 2 and rig.runs()[1]["status"] == "requested"
    assert rig.work(harness, event) == "skipped"  # a late resume of the dead run does nothing


def test_a_retry_blocked_by_the_cap_is_counted_and_logged_then_goes_out(rig, harness, caplog):
    rig.settings["max_active_runs"] = 1
    harness.osv.serve(NPM, Response(status=503))
    rig.tick()
    assert rig.work(harness, rig.published[0]) == "failed"
    rig.advance(RETRY_DELAYS[0] + 1)
    rig.admin.execute("UPDATE scheduler_leases SET next_due_at = now() - interval '1 second'")
    before = sample("scheduler_ticks_skipped_total", source="osv", ecosystem="npm", reason="retry_cap")
    with caplog.at_level(logging.WARNING, logger="crawler"):
        rig.tick()  # the due tick takes the only slot, so the retry waits
    assert [r["trigger"] for r in rig.runs()] == ["schedule", "schedule"]
    assert sample("scheduler_ticks_skipped_total", source="osv", ecosystem="npm", reason="retry_cap") - before == 1
    assert "retry deferred" in caplog.text

    assert rig.work(harness, rig.published[1]) == "failed"  # slot freed
    rig.advance(RETRY_DELAYS[0] + 1)
    rig.tick()
    assert "retry" in [r["trigger"] for r in rig.runs()]


def test_an_exhausted_retry_chain_is_logged(rig, harness, caplog):
    harness.osv.serve(NPM, Response(status=503))
    scheduler = rig.scheduler()
    scheduler.run_once()
    event = rig.published[0]
    for delay in (*RETRY_DELAYS, 0):
        assert rig.work(harness, event) == "failed"
        if not delay:
            break
        rig.advance(delay + 1)
        scheduler.run_once()
        event = rig.published[-1]
    with caplog.at_level(logging.INFO, logger="crawler"):
        scheduler.run_once()
    assert "retry chain exhausted" in caplog.text


def test_an_expired_request_is_retried_like_a_transient_failure(rig):
    rig.settings["expiry_seconds"] = 1
    rig.tick()
    (lost,) = rig.runs()
    rig.advance(2)
    rig.tick()  # expires
    rig.advance(RETRY_DELAYS[0] + 1)
    rig.tick()
    assert [(r["trigger"], r["retry_of"]) for r in rig.runs()] == [
        ("schedule", None),
        ("retry", lost["run_id"]),
    ]


def test_a_publish_failure_fails_the_row_at_once_and_frees_the_slot(rig):
    rig.publish_error = ConnectionError("broker down")
    rig.tick()
    (run,) = rig.runs()
    assert (run["status"], run["failure_kind"], run["error"]) == (
        "failed",
        "transient",
        "publish failed: ConnectionError",
    )
    assert run["completed_at"] is not None and rig.published == []

    rig.publish_error = None
    rig.advance(RETRY_DELAYS[0] + 1)
    rig.tick()
    assert [r["trigger"] for r in rig.runs()] == ["schedule", "retry"] and len(rig.published) == 1


def test_a_scheduler_pass_that_fails_does_not_stop_the_loop(rig, caplog):
    rig.settings["schedules"] = [NPM_SCHEDULE]
    scheduler = rig.scheduler()
    scheduler.settings = SchedulerSettings(
        "postgresql://nobody@127.0.0.1:1/none", KEYS, [NPM_SCHEDULE], tick_seconds=0.01
    )
    stop = threading.Event()
    before = sample("scheduler_loop_errors_total")
    thread = threading.Thread(target=scheduler.run, args=(stop,))
    with caplog.at_level(logging.ERROR, logger="crawler"):
        thread.start()
        while sample("scheduler_loop_errors_total") - before < 2:
            thread.join(0.05)
        stop.set()
        thread.join(10)
    assert not thread.is_alive() and "scheduler pass failed" in caplog.text


def test_the_scheduler_role_can_touch_only_the_run_tables(scheduler_url, rig):
    rig.tick()
    with psycopg.connect(scheduler_url, autocommit=True) as conn:
        assert conn.execute("SELECT count(*) FROM ingestion_runs").fetchone() == (1,)
        for statement in (
            "SELECT 1 FROM users",
            "SELECT 1 FROM organizations",
            "SELECT 1 FROM projects",
            "SELECT 1 FROM sbom_imports",
            "DELETE FROM ingestion_runs",
            "TRUNCATE scheduler_leases",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(statement)  # type: ignore[arg-type]
