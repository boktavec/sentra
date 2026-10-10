import json
import os
import threading
import time
import uuid

import pytest
from confluent_kafka import Consumer, KafkaError, KafkaException, Producer, TopicPartition
from confluent_kafka.admin import AdminClient, NewTopic  # pyright: ignore[reportPrivateImportUsage]
from prometheus_client import REGISTRY

from conftest import make_request
from crawler import contracts, request
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
    names = list(vars(t).values())
    created = []
    try:
        for name, fut in admin.create_topics(
            [NewTopic(n, num_partitions=1, replication_factor=1) for n in names]
        ).items():
            fut.result(15)
            created.append(name)
        yield t
    finally:
        if created:
            for fut in admin.delete_topics(created).values():
                fut.result(15)


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


def test_a_scheduled_request_travels_through_kafka_to_a_finished_run(harness, topics, rig, admin):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    producer = Producer({"bootstrap.servers": BOOTSTRAP})
    scheduler = rig.scheduler(publish=lambda event: request.publish(producer, event, topics.requested))
    with Running(harness, topics) as w:
        scheduler.run_once()
        (event,) = read(topics.ingested, 1)
        wait_for(lambda: w.committed() == 1)
    row = admin.execute("SELECT run_id::text, status, trigger, completed_at IS NOT NULL FROM ingestion_runs").fetchone()
    assert row == (event["runId"], "published", "schedule", True)


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
    contracts.validate("crawl.failed", event, version=2)
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


# --- SENTRA-30: poison messages and dependency failures must never wedge or kill the worker ---


class FlakyConsumer:
    """Wraps the real consumer and raises on the first commit() or seek(): the only fake here, because a
    broker-side rebalance cannot be triggered on demand. Everything else is the real client."""

    def __init__(self, real, fail: str):
        self._real, self._fail = real, fail

    def __getattr__(self, name):
        attr = getattr(self._real, name)
        if name == self._fail:

            def once(*a, **kw):
                self._fail = ""
                raise KafkaException(KafkaError(KafkaError._TRANSPORT))

            return once
        return attr


def good_request(harness, ecosystem="npm"):
    harness.osv.serve(f"/{ecosystem}/all.zip", Response(body=make_zip(), etag='"v1"'))
    return make_request(ecosystem=ecosystem)


def test_unencodable_string_in_a_signed_looking_request_does_not_block_the_partition(harness, topics):
    good = good_request(harness)
    keyed_poison = json.dumps({**make_request(), "ecosystem": "\ud800"}).encode()  # ensure_ascii: stays \ud800
    with Running(harness, topics) as w:
        produce(topics.requested, keyed_poison, good)
        (event,) = read(topics.ingested, 1)
        wait_for(lambda: w.committed() == 2)
    assert event["runId"] == good["runId"]


@pytest.mark.parametrize(
    "payload",
    [
        b"[" * 900_000,
        json.dumps({**make_request(), "ecosystem": [[]]}).encode().replace(b"[[]]", b"[" * 900 + b"]" * 900),
    ],
    ids=["unparseable-nesting", "deeply-nested-field"],
)
def test_pathologically_nested_json_is_dropped_not_retried_forever(harness, topics, payload):
    good = good_request(harness)
    with Running(harness, topics) as w:
        produce(topics.requested, payload, good)
        (event,) = read(topics.ingested, 1)
        wait_for(lambda: w.committed() == 2)
    assert event["runId"] == good["runId"]


def test_deterministic_failure_is_given_up_after_a_bounded_number_of_attempts(harness, topics, admin):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    deps = harness.deps()
    real_put, calls = deps.store.put, []
    bad = make_request()

    def broken_for_the_bad_run(*args, **kwargs):
        if kwargs["run_id"] != bad["runId"]:
            return real_put(*args, **kwargs)
        calls.append(1)
        raise ValueError("a bug, not an outage")

    deps.store.put = broken_for_the_bad_run  # type: ignore[method-assign]
    good = good_request(harness, "PyPI")
    before = sample("dropped_poison")
    with Running(harness, topics, deps) as w:
        produce(topics.requested, bad, good)
        (failed,) = read(topics.failed, 1)
        (event,) = read(topics.ingested, 1)
        wait_for(lambda: w.committed() == 2)
    assert failed["runId"] == bad["runId"] and event["runId"] == good["runId"]
    assert len(calls) == 3  # bounded, then committed
    assert (
        admin.execute("SELECT status FROM ingestion_runs WHERE run_id = %s", (bad["runId"],)).fetchone()[0] == "failed"
    )
    assert sample("dropped_poison") == before + 1


def test_dependency_outages_are_retried_beyond_the_poison_bound(harness, topics):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    deps = harness.deps()
    real_put, calls = deps.store.put, []

    def flaky_put(*args, **kwargs):
        calls.append(1)
        if len(calls) <= 6:  # more than the poison bound: an outage must never be mistaken for a bad message
            raise OSError("object store unavailable")
        return real_put(*args, **kwargs)

    deps.store.put = flaky_put  # type: ignore[method-assign]
    req = make_request()
    with Running(harness, topics, deps) as w:
        produce(topics.requested, req)
        (event,) = read(topics.ingested, 1)
        wait_for(lambda: w.committed() == 1)
    assert event["runId"] == req["runId"] and len(calls) == 7


@pytest.mark.parametrize("failing_call", ["commit", "seek"])
def test_commit_and_seek_errors_do_not_kill_the_worker(harness, topics, failing_call):
    deps = harness.deps()
    if failing_call == "seek":  # seek is only reached on the error path
        harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
        real_put, calls = deps.store.put, []

        def flaky_put(*a, **kw):
            calls.append(1)
            if len(calls) == 1:
                raise OSError("object store unavailable")
            return real_put(*a, **kw)

        deps.store.put = flaky_put  # type: ignore[method-assign]
        req = make_request()
    else:
        req = good_request(harness)
    running = Running(harness, topics, deps)
    running.worker.consumer = FlakyConsumer(running.worker.consumer, failing_call)  # pyright: ignore[reportAttributeAccessIssue]
    with running as w:
        produce(topics.requested, req)
        (event,) = read(topics.ingested, 1)
        wait_for(lambda: w.committed() == 1)
        assert w.thread.is_alive(), "the worker died"
    assert event["runId"] == req["runId"]


def test_worker_recovers_when_its_database_connection_is_killed(harness, topics, admin):
    first = good_request(harness, "npm")
    second = good_request(harness, "PyPI")
    with Running(harness, topics) as w:
        produce(topics.requested, first)
        read(topics.ingested, 1)
        wait_for(lambda: w.committed() == 1)
        # A restart, failover or idle-timeout kill on the database side:
        admin.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE usename = 'sentra_crawler' AND pid <> pg_backend_pid()"
        )
        produce(topics.requested, second)
        events = read(topics.ingested, 2)
        wait_for(lambda: w.committed() == 2)
    assert {e["runId"] for e in events} == {first["runId"], second["runId"]}


class FakeMsg:
    """The one thing a Kafka Message is asked for by _give_up: its payload."""

    def __init__(self, value: bytes):
        self._value = value

    def value(self) -> bytes:
        return self._value


def status(admin, run_id):
    row = admin.execute("SELECT status FROM ingestion_runs WHERE run_id = %s", (run_id,)).fetchone()
    return row[0] if row else None


def test_abandoning_a_validly_signed_request_fails_its_run_and_announces_it(harness, topics, admin):
    req = make_request()
    admin.execute(
        "INSERT INTO ingestion_runs (run_id, source, ecosystem, correlation_id) VALUES (%s, 'osv', 'npm', 'c')",
        (req["runId"],),
    )
    worker = Worker(harness.deps(), BOOTSTRAP, topics, group=f"test-{uuid.uuid4().hex[:8]}")
    worker._give_up(FakeMsg(json.dumps(req).encode()), "ValueError: boom")  # type: ignore[arg-type]
    worker.consumer.close()
    (event,) = read(topics.failed, 1)
    assert event["runId"] == req["runId"] and status(admin, req["runId"]) == "failed"
    assert event["failureKind"] == "permanent"


@pytest.mark.parametrize("tamper", ["bad-signature", "unknown-key", "not-json"])
def test_abandoning_an_unverified_message_never_touches_anyone_elses_run(harness, topics, admin, tamper):
    victim = make_request()
    admin.execute(
        "INSERT INTO ingestion_runs (run_id, source, ecosystem, correlation_id) VALUES (%s, 'osv', 'npm', 'c')",
        (victim["runId"],),
    )
    payload = {
        "bad-signature": json.dumps({**victim, "signature": "0" * 64}).encode(),
        "unknown-key": json.dumps(make_request(run_id=victim["runId"], key_id="nobody")).encode(),
        "not-json": b"\xff\xfe garbage",
    }[tamper]
    worker = Worker(harness.deps(), BOOTSTRAP, topics, group=f"test-{uuid.uuid4().hex[:8]}")
    worker._give_up(FakeMsg(payload), "ValueError: boom")  # type: ignore[arg-type]
    worker.consumer.close()
    assert status(admin, victim["runId"]) == "fetching"
    assert read(topics.failed, 1, timeout=2) == []
