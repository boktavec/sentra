import json
import os
import threading
import time
import uuid

import pytest
from confluent_kafka import Consumer, Producer, TopicPartition
from confluent_kafka.admin import AdminClient, NewTopic  # pyright: ignore[reportPrivateImportUsage]
from conftest import Harness

from pipeline.worker import Worker

BOOTSTRAP = os.environ.get("TEST_KAFKA_BOOTSTRAP", "127.0.0.1:19092")


@pytest.fixture
def topic():
    """A fresh single-partition topic, so tests never see each other's messages."""
    name = f"{uuid.uuid4().hex[:8]}.sbom.uploaded"
    admin = AdminClient({"bootstrap.servers": BOOTSTRAP})
    for fut in admin.create_topics([NewTopic(name, num_partitions=1, replication_factor=1)]).values():
        fut.result(15)
    return name


class Running:
    def __init__(self, harness: Harness, topic: str):
        self.group = f"test-{uuid.uuid4().hex[:8]}"
        self.topic = topic
        self.worker = Worker(harness.deps(), BOOTSTRAP, topic, group=self.group, retry_pause=0.2)
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.worker.run, args=(self.stop,), daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.thread.join(20)
        assert not self.thread.is_alive(), "worker did not stop"

    def committed(self) -> int:
        c = Consumer({"bootstrap.servers": BOOTSTRAP, "group.id": self.group, "enable.auto.commit": False})
        try:
            (tp,) = c.committed([TopicPartition(self.topic, 0)], timeout=10)
            return tp.offset if tp.offset >= 0 else 0
        finally:
            c.close()


def produce(topic: str, *values: dict | bytes) -> None:
    p = Producer({"bootstrap.servers": BOOTSTRAP})
    for v in values:
        p.produce(topic, value=v if isinstance(v, bytes) else json.dumps(v).encode())
    p.flush(10)


def wait_for(check, timeout: float = 20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if result := check():
            return result
        time.sleep(0.1)
    raise AssertionError("condition not reached in time")


def test_an_uploaded_event_flows_through_the_broker_to_a_parsed_import(harness: Harness, valid_sbom: bytes, topic: str):
    import_id = harness.add_import(valid_sbom)

    with Running(harness, topic) as running:
        produce(topic, harness.event(import_id))
        wait_for(lambda: harness.row(import_id)["status"] == "parsed")
        wait_for(lambda: running.committed() == 1)


def test_garbage_and_invalid_events_are_committed_not_retried(harness: Harness, valid_sbom: bytes, topic: str):
    import_id = harness.add_import(valid_sbom)

    with Running(harness, topic) as running:
        produce(topic, b"not json", b"[1]", harness.event(import_id, version=9), harness.event(import_id))
        wait_for(lambda: harness.row(import_id)["status"] == "parsed")
        wait_for(lambda: running.committed() == 4)


def test_an_event_whose_failure_cannot_be_recorded_is_redelivered(harness: Harness, valid_sbom: bytes, topic: str):
    """Storage and the final write both fail: the offset stays put, and the retry succeeds once storage is back."""
    import_id = harness.add_import(valid_sbom)
    # Reads fail for every attempt of the first delivery (3), then recover for the redelivery.
    harness.flaky.fail_reads = 3
    # Make recording processing_failed impossible by locking the row's status from the pipeline's view.
    harness.admin.execute("ALTER TABLE sbom_imports ADD CONSTRAINT hold CHECK (status <> 'rejected') NOT VALID")
    try:
        with Running(harness, topic) as running:
            produce(topic, harness.event(import_id))
            wait_for(lambda: harness.row(import_id)["status"] == "parsed")
            wait_for(lambda: running.committed() == 1)
    finally:
        harness.admin.execute("ALTER TABLE sbom_imports DROP CONSTRAINT hold")
