import json
import logging
import threading

from confluent_kafka import Consumer, KafkaError, Message, TopicPartition

from .metrics import VALIDATIONS, WORKER_ERRORS
from .process import Deps, handle

log = logging.getLogger("pipeline")

TOPIC = "sbom.uploaded"
GROUP = "pipeline-sbom"


class Worker:
    """Consumes sbom.uploaded with manual offset commits (at-least-once).

    handle() commits normal outcomes, including dropped bad events and permanently failed imports, so
    a poison message cannot block the partition. If it raises (the failure could not be recorded) the
    offset stays uncommitted and the consumer seeks back, so the event is redelivered after a pause.
    """

    def __init__(self, deps: Deps, bootstrap: str, topic: str = TOPIC, group: str = GROUP, retry_pause: float = 5.0):
        self.deps, self.topic, self.retry_pause = deps, topic, retry_pause
        self.consumer = Consumer(
            {
                "bootstrap.servers": bootstrap,
                "group.id": group,
                "enable.auto.commit": False,
                "auto.offset.reset": "earliest",
                # Retries with backoff can take a minute or two; don't get kicked out of the group mid-event.
                "max.poll.interval.ms": 15 * 60 * 1000,
            }
        )

    def _process(self, msg: Message) -> None:
        try:
            event = json.loads(msg.value() or b"")
            if not isinstance(event, dict):
                raise ValueError("not a JSON object")
        except ValueError:
            VALIDATIONS.labels("dropped_invalid").inc()
            log.warning("event dropped", extra={"outcome": "dropped_invalid", "reason": "payload is not a JSON object"})
            return
        handle(event, self.deps)

    def run(self, stop: threading.Event) -> None:
        self.consumer.subscribe([self.topic])
        log.info("worker started")
        try:
            while not stop.is_set():
                msg = self.consumer.poll(1.0)
                if msg is None:
                    continue
                if msg.error():
                    # A missing topic is expected until the first producer creates it.
                    err = msg.error()
                    level = logging.WARNING if err and err.code() == KafkaError.UNKNOWN_TOPIC_OR_PART else logging.ERROR
                    log.log(level, "consumer error", extra={"reason": str(msg.error())})
                    continue
                try:
                    self._process(msg)
                except Exception as e:
                    WORKER_ERRORS.inc()
                    log.error("event failed, will retry", extra={"reason": f"{type(e).__name__}: {e}"})
                    self.consumer.seek(
                        TopicPartition(str(msg.topic()), int(msg.partition() or 0), int(msg.offset() or 0))
                    )
                    stop.wait(self.retry_pause)
                    continue
                self.consumer.commit(message=msg, asynchronous=False)
        finally:
            self.consumer.close()
            log.info("worker stopped")
