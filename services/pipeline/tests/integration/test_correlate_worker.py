"""The correlator worker over real Redpanda: events in, findings out, and a sweep with no events at all."""

import threading
import uuid
from contextlib import contextmanager
from dataclasses import replace

import pytest
from confluent_kafka.admin import AdminClient, NewTopic  # pyright: ignore[reportPrivateImportUsage]
from correlate_support import FIXED_AT_0_10, TRAC, World
from test_worker import BOOTSTRAP, produce, wait_for

from pipeline import events
from pipeline.correlate.config import Limits
from pipeline.correlate.process import Deps
from pipeline.correlate.store import Store
from pipeline.correlate.worker import Worker


@pytest.fixture
def topic():
    name = f"{uuid.uuid4().hex[:8]}.correlate"
    admin = AdminClient({"bootstrap.servers": BOOTSTRAP})
    for fut in admin.create_topics([NewTopic(name, num_partitions=1, replication_factor=1)]).values():
        fut.result(15)
    try:
        yield name
    finally:
        for fut in admin.delete_topics([name]).values():
            fut.result(15)


@contextmanager
def running(world: World, topic: str, **limits):
    store = Store(world.url)
    worker = Worker(
        Deps(store=store, limits=replace(Limits(), **limits)),
        BOOTSTRAP,
        [topic],
        group=f"test-{uuid.uuid4().hex[:8]}",
        retry_pause=0.2,
    )
    stop = threading.Event()
    thread = threading.Thread(target=worker.run, args=(stop,), daemon=True)
    thread.start()
    try:
        yield worker
    finally:
        stop.set()
        thread.join(20)
        store.close()
        assert not thread.is_alive()


def test_a_parsed_event_becomes_findings_and_poison_does_not_block(world: World, topic: str):
    imp = world.sbom([TRAC])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)
    parsed = events.sbom_parsed(imp, str(world.org), str(world.project), "corr-1", 1)
    produce(topic, b"{definitely not json", {"type": "sbom.parsed"}, {"type": "unknown.thing"}, parsed)

    with running(world, topic, sweep_interval_seconds=10**9):
        # The first sweep may get there before the event does; the event is handled either way.
        wait_for(lambda: world.admin.execute("SELECT 1 FROM match_runs WHERE status = 'completed'").fetchall())

    assert [f["source_id"] for f in world.findings()] == ["PYSEC-1"]
    assert world.admin.execute("SELECT status FROM match_runs").fetchall() == [("completed",)]


def test_a_sweep_finds_work_that_no_event_announced(world: World, topic: str):
    world.sbom([TRAC])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)

    with running(world, topic, sweep_interval_seconds=0):
        wait_for(lambda: world.findings())

    assert [f["status"] for f in world.findings()] == ["open"]
