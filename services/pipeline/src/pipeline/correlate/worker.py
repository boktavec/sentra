import json
import logging
import threading
from typing import Any

from confluent_kafka import Consumer, KafkaError, Message, TopicPartition

from . import metrics
from .process import NORMALIZED, PARSED, Deps, handle
from .sweep import Sweep

log = logging.getLogger("pipeline")

TOPICS = [PARSED, NORMALIZED]
GROUP = "correlator"


class Worker:
    """Consumes sbom.parsed and vulnerabilities.normalized with manual offset commits (at-least-once), and
    steps the scheduled sweep between polls.

    handle() commits normal outcomes, including dropped events. An exception (the database was
    unavailable, say) leaves the offset uncommitted and the consumer seeks back, so the event is
    redelivered after a pause. An event that keeps failing for another reason is given up on after
    `max_attempts`: the sweep reconciles whatever it would have.
    """

    def __init__(
        self, deps: Deps, bootstrap: str, topics: list[str] | None = None, group: str = GROUP, retry_pause: float = 5.0
    ):
        self.deps, self.retry_pause, self.topics = deps, retry_pause, topics or TOPICS
        self.sweep = Sweep(deps)
        self._attempts: dict[tuple[str, int, int], int] = {}
        self.consumer = Consumer(
            {
                "bootstrap.servers": bootstrap,
                "group.id": group,
                "enable.auto.commit": False,
                "auto.offset.reset": "earliest",
                "max.poll.interval.ms": 15 * 60 * 1000,
            }
        )

    def _process(self, msg: Message) -> None:
        try:
            event: Any = json.loads(msg.value() or b"")
            if not isinstance(event, dict):
                raise ValueError("not a JSON object")
        except ValueError, RecursionError:
            metrics.EVENTS.labels("unknown", "dropped_invalid").inc()
            log.warning("event dropped", extra={"outcome": "dropped_invalid", "reason": "payload is not a JSON object"})
            return
        outcome = handle(event, self.deps)
        log.info("event handled", extra={"outcome": outcome, "correlationId": event.get("correlationId", "")})

    def run(self, stop: threading.Event) -> None:
        self.consumer.subscribe(self.topics)
        log.info("worker started")
        try:
            while not stop.is_set():
                self._tick()
                # A running sweep must not starve events: poll without waiting while it has work left.
                msg = self.consumer.poll(0 if self.sweep.active else 1.0)
                if msg is None:
                    continue
                if msg.error():
                    # A missing topic is expected until the first producer creates it.
                    err = msg.error()
                    level = logging.WARNING if err and err.code() == KafkaError.UNKNOWN_TOPIC_OR_PART else logging.ERROR
                    log.log(level, "consumer error", extra={"reason": str(msg.error())})
                    continue
                self._consume(msg, stop)
        finally:
            self.consumer.close()
            log.info("worker stopped")

    def _tick(self) -> None:
        """One sweep step per loop; errors here must not kill the worker, the next tick retries."""
        try:
            self.sweep.update_age()
            if self.sweep.maybe_start():
                self.sweep.step()
        except Exception as e:
            metrics.WORKER_ERRORS.inc()
            self.sweep.active = False
            log.error("sweep step failed", extra={"reason": f"{type(e).__name__}: {e}"})
            try:
                self.deps.store.release_sweep()
            except Exception:  # the lease then simply expires
                log.warning("sweep lease not released")

    def _consume(self, msg: Message, stop: threading.Event) -> None:
        key = (str(msg.topic()), int(msg.partition() or 0), int(msg.offset() or 0))
        try:
            self._process(msg)
        except Exception as e:
            metrics.WORKER_ERRORS.inc()
            self._attempts[key] = self._attempts.get(key, 0) + 1
            if self._attempts[key] < self.deps.limits.max_attempts:
                log.error("event failed, will retry", extra={"reason": f"{type(e).__name__}: {e}"})
                self.consumer.seek(TopicPartition(*key))
                stop.wait(self.retry_pause)
                return
            log.error("event abandoned, the sweep will cover it", extra={"reason": f"{type(e).__name__}: {e}"})
        self._attempts.pop(key, None)
        self.consumer.commit(message=msg, asynchronous=False)
