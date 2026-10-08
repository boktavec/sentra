import json
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any

from confluent_kafka import Consumer, KafkaError, KafkaException, Message, Producer, TopicPartition

from .ingest import Deps, handle
from .metrics import REQUESTS, RUN_SECONDS, WORKER_ERRORS

log = logging.getLogger("crawler")


@dataclass(frozen=True)
class Topics:
    requested: str = "crawl.requested"
    ingested: str = "artifact.ingested"
    failed: str = "crawl.failed"

    def for_event(self, event_type: str) -> str:
        return {"artifact.ingested": self.ingested, "crawl.failed": self.failed}[event_type]


class Worker:
    """Consumes crawl.requested with manual offset commits (at-least-once) and publishes results.

    An offset is committed only after handle() returns: normal outcomes, including a dropped bad
    request or a permanently failed run, are committed so a poison message cannot block the partition.
    If handle() raises (storage, database or broker down) the offset stays uncommitted and the
    consumer seeks back to it, so the message is redelivered after a pause.
    """

    def __init__(
        self,
        deps: Deps,
        bootstrap: str,
        topics: Topics | None = None,
        group: str = "sentra-crawler",
        retry_pause: float = 5.0,
    ):
        self.topics, self.retry_pause = topics or Topics(), retry_pause
        self.deps = deps
        self.producer = Producer({"bootstrap.servers": bootstrap, "enable.idempotence": True, "acks": "all"})
        self.consumer = Consumer(
            {
                "bootstrap.servers": bootstrap,
                "group.id": group,
                "enable.auto.commit": False,
                "auto.offset.reset": "earliest",
                # One request can download for up to the total timeout; don't get kicked out of the group mid-run.
                "max.poll.interval.ms": 60 * 60 * 1000,
            }
        )
        deps.publish = self.publish

    def publish(self, event: dict[str, Any]) -> None:
        """Synchronous produce: returns only once the broker acknowledged, else raises."""
        error: list[Exception] = []

        def done(err: Any, _msg: Any) -> None:
            if err is not None:
                error.append(KafkaException(err))

        self.producer.produce(
            self.topics.for_event(event["type"]), key=event["runId"], value=json.dumps(event).encode(), on_delivery=done
        )
        if self.producer.flush(30) > 0:
            raise TimeoutError("broker did not acknowledge the event in 30s")
        if error:
            raise error[0]

    def _process(self, msg: Message) -> None:
        try:
            event = json.loads(msg.value() or b"")
            if not isinstance(event, dict):
                raise ValueError("not a JSON object")
        except ValueError:
            REQUESTS.labels("dropped_invalid").inc()
            log.warning("request dropped", extra={"reason": "payload is not a JSON object"})
            return
        started = time.monotonic()
        outcome = handle(event, self.deps)
        RUN_SECONDS.observe(time.monotonic() - started)
        REQUESTS.labels(outcome).inc()

    def run(self, stop: threading.Event) -> None:
        self.consumer.subscribe([self.topics.requested])
        log.info("worker started")
        try:
            while not stop.is_set():
                msg = self.consumer.poll(1.0)
                if msg is None:
                    continue
                if msg.error():
                    # A missing topic is expected until infra (or the first producer) creates it.
                    err = msg.error()
                    level = logging.WARNING if err and err.code() == KafkaError.UNKNOWN_TOPIC_OR_PART else logging.ERROR
                    log.log(level, "consumer error", extra={"reason": str(msg.error())})
                    continue
                try:
                    self._process(msg)
                except Exception as e:  # noqa: BLE001 - any failure means "redeliver", never "lose"
                    WORKER_ERRORS.inc()
                    log.error("request failed, will retry", extra={"reason": f"{type(e).__name__}: {e}"})
                    self.consumer.seek(
                        TopicPartition(str(msg.topic()), int(msg.partition() or 0), int(msg.offset() or 0))
                    )
                    stop.wait(self.retry_pause)
                    continue
                self.consumer.commit(message=msg, asynchronous=False)
        finally:
            self.consumer.close()
            log.info("worker stopped")
