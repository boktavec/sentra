"""The normalizer worker over real Redpanda: artifact.ingested in, vulnerabilities.normalized out."""

import json
import threading
import time
import uuid

import pytest
from confluent_kafka import Consumer
from confluent_kafka.admin import AdminClient, NewTopic  # pyright: ignore[reportPrivateImportUsage]
from normalize_support import good_entries
from test_worker import BOOTSTRAP, produce, wait_for

from pipeline.normalize.worker import Worker


@pytest.fixture
def topic():
    name = f"{uuid.uuid4().hex[:8]}.artifact.ingested"
    admin = AdminClient({"bootstrap.servers": BOOTSTRAP})
    for fut in admin.create_topics([NewTopic(name, num_partitions=1, replication_factor=1)]).values():
        fut.result(15)
    return name


def normalized_events(sha: str, timeout: float = 20) -> list[dict]:
    """Read vulnerabilities.normalized from the start and return the events for one artifact."""
    consumer = Consumer(
        {"bootstrap.servers": BOOTSTRAP, "group.id": f"t-{uuid.uuid4().hex[:8]}", "auto.offset.reset": "earliest"}
    )
    consumer.subscribe(["vulnerabilities.normalized"])
    found: list[dict] = []
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline and not found:
            msg = consumer.poll(1.0)
            if msg is not None and not msg.error():
                event = json.loads(msg.value() or b"")
                if event["artifactSha256"] == sha:
                    found.append(event)
    finally:
        consumer.close()
    return found


def test_artifact_event_in_normalized_event_out_and_poison_does_not_block(env, topic):
    _, sha = env.upload(good_entries())
    produce(topic, b"{definitely not json", {"type": "artifact.ingested"}, env.event(sha))

    worker = Worker(env.deps(), BOOTSTRAP, topic, group=f"test-{uuid.uuid4().hex[:8]}", retry_pause=0.2)
    stop = threading.Event()
    thread = threading.Thread(target=worker.run, args=(stop,), daemon=True)
    thread.start()
    try:
        wait_for(lambda: env.q("SELECT status FROM normalization_runs") == [("published",)])
    finally:
        stop.set()
        thread.join(20)
    assert not thread.is_alive()
    (event,) = normalized_events(sha)
    assert event["counts"]["upserted"] == len(good_entries())
    assert env.q("SELECT count(*) FROM vulnerabilities") == [(len(good_entries()),)]
