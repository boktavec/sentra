import json
import os
import threading
import time
import uuid

import pytest
from confluent_kafka import Consumer, Producer, TopicPartition
from confluent_kafka.admin import AdminClient, NewTopic  # pyright: ignore[reportPrivateImportUsage]
from prometheus_client import REGISTRY

from conftest import make_request
from crawler import contracts
from crawler.worker import Topics, Worker
from fake_osv import Response, make_zip

BOOTSTRAP = os.environ.get("TEST_KAFKA_BOOTSTRAP", "127.0.0.1:19092")
NPM = "/npm/all.zip"


@pytest.fixture
def topics():
    """Three fresh single-partition topics, so tests never see each other's messages."""
    tag = uuid.uuid4().hex[:8]
    t = Topics(f"{tag}.crawl.requested", f"{tag}.artifact.ingested", f"{tag}.crawl.failed")
    admin = AdminClient({"bootstrap.servers": BOOTSTRAP})
    for fut in admin.create_topics(
        [NewTopic(n, num_partitions=1, replication_factor=1) for n in vars(t).values()]
    ).values():
        fut.result(15)
    return t


class Running:
    def __init__(self, harness, topics, deps=None):
        self.group = f"test-{uuid.uuid4().hex[:8]}"
        self.topics = topics
        self.worker = Worker(deps or harness.deps(), BOOTSTRAP, topics, group=self.group, retry_pause=0.2)
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
            (tp,) = c.committed([TopicPartition(self.topics.requested, 0)], timeout=10)
            return tp.offset if tp.offset >= 0 else 0
        finally:
            c.close()


def produce(topic: str, *values: dict | bytes) -> None:
    p = Producer({"bootstrap.servers": BOOTSTRAP})
    for v in values:
        p.produce(topic, value=v if isinstance(v, bytes) else json.dumps(v).encode())
    p.flush(10)


def read(topic: str, count: int, timeout: float = 20) -> list[dict]:
    c = Consumer({"bootstrap.servers": BOOTSTRAP, "group.id": uuid.uuid4().hex, "auto.offset.reset": "earliest"})
    c.subscribe([topic])
    out: list[dict] = []
    deadline = time.monotonic() + timeout
    try:
        while len(out) < count and time.monotonic() < deadline:
            m = c.poll(0.5)
            if m is not None and not m.error():
                out.append(json.loads(m.value() or b"null"))
    finally:
        c.close()
    return out


def wait_for(cond, timeout: float = 20) -> None:
    deadline = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < deadline, "timed out waiting"
        time.sleep(0.1)


def sample(outcome: str) -> float:
    return REGISTRY.get_sample_value("crawler_requests_total", {"outcome": outcome}) or 0.0


def test_end_to_end_request_to_event(harness, topics):
    body = make_zip()
    harness.osv.serve(NPM, Response(body=body, etag='"v1"'))
    req = make_request()
    before = sample("published")
    with Running(harness, topics):
        produce(topics.requested, req)
        (event,) = read(topics.ingested, 1)
    contracts.validate("artifact.ingested", event)
    assert event["runId"] == req["runId"] and event["correlationId"] == req["correlationId"]
    stored = harness.s3.get_object(Bucket=harness.bucket, Key=event["artifact"]["key"])["Body"].read()
    assert stored == body
    assert sample("published") == before + 1


def test_duplicate_requests_yield_one_event_and_one_download(harness, topics):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    req = make_request()
    with Running(harness, topics) as w:
        produce(topics.requested, req, req)
        wait_for(lambda: w.committed() == 2)
    assert len(read(topics.ingested, 2, timeout=3)) == 1
    assert harness.osv.count(NPM) == 1


def test_poison_messages_are_committed_and_do_not_block_the_partition(harness, topics):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    good = make_request()
    bad_sig = {**make_request(), "signature": "0" * 64}
    before = (sample("dropped_invalid"), sample("dropped_signature"))
    with Running(harness, topics) as w:
        produce(topics.requested, b"\xff\xfenot json", b"[1, 2]", bad_sig, good)
        (event,) = read(topics.ingested, 1)
        wait_for(lambda: w.committed() == 4)
    assert event["runId"] == good["runId"]
    assert (sample("dropped_invalid"), sample("dropped_signature")) == (before[0] + 2, before[1] + 1)


def test_permanent_failure_publishes_crawl_failed_and_moves_on(harness, topics):
    harness.osv.serve(NPM, Response(status=503))
    req = make_request()
    with Running(harness, topics) as w:
        produce(topics.requested, req)
        (event,) = read(topics.failed, 1)
        wait_for(lambda: w.committed() == 1)
    contracts.validate("crawl.failed", event)
    assert event["runId"] == req["runId"] and event["attempts"] == 3
    assert read(topics.ingested, 1, timeout=2) == []


def test_dependency_outage_leaves_the_message_uncommitted_then_redelivers(harness, topics):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    deps = harness.deps()
    real_put, calls = deps.store.put, []

    def flaky_put(*args, **kwargs):
        calls.append(1)
        if len(calls) <= 2:
            raise OSError("object store unavailable")
        return real_put(*args, **kwargs)

    deps.store.put = flaky_put  # type: ignore[method-assign]
    req = make_request()
    with Running(harness, topics, deps) as w:
        produce(topics.requested, req)
        (event,) = read(topics.ingested, 1)
        wait_for(lambda: w.committed() == 1)
    assert event["runId"] == req["runId"] and len(calls) == 3  # two failures, then success on redelivery
