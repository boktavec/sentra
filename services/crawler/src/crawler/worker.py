import json
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any

import psycopg
from botocore.exceptions import BotoCoreError, ClientError
from confluent_kafka import Consumer, KafkaError, KafkaException, Message, Producer, TopicPartition

from . import contracts, events, signing
from .ingest import Deps, handle
from .metrics import REQUESTS, RUN_SECONDS, WORKER_ERRORS

log = logging.getLogger("crawler")

# Failures of something we depend on (object store, database, broker). These are retried for as long as the
# outage lasts, so an outage is never mistaken for a bad message. Anything else raised while handling a
# request is a bug or hostile input: it is retried a few times, then the request is abandoned.
TRANSIENT = (OSError, KafkaException, psycopg.OperationalError, psycopg.InterfaceError, BotoCoreError, ClientError)


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
    If handle() raises because a dependency is down, the offset stays uncommitted and the consumer seeks
    back to it, so the message is redelivered after a pause, for as long as the outage lasts. If it keeps
    raising anything else, the request is abandoned after `max_attempts` so it cannot wedge the partition.
    Commit and seek errors (rebalance, broker blip) are retried and never kill the worker.
    """

    def __init__(
        self,
        deps: Deps,
        bootstrap: str,
        topics: Topics | None = None,
        group: str = "sentra-crawler",
        retry_pause: float = 5.0,
        max_attempts: int = 3,
    ):
        self.topics, self.retry_pause, self.max_attempts = topics or Topics(), retry_pause, max_attempts
        self._failing: tuple[str | None, int | None, int | None] | None = None
        self._failures = 0
        self.deps = deps
        self.producer = Producer({"bootstrap.servers": bootstrap, "enable.idempotence": True, "acks": "all"})
        self.consumer = Consumer(
            {
                "bootstrap.servers": bootstrap,
                "group.id": group,
                "enable.auto.commit": False,
                "auto.offset.reset": "earliest",
                # One request can legitimately run for the whole claim lease; don't get evicted mid-run.
                "max.poll.interval.ms": deps.limits.poll_interval_ms,
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
        except ValueError, RecursionError:  # RecursionError: absurdly nested JSON
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
                except Exception as e:  # noqa: BLE001 - any failure means "retry or give up", never "lose"
                    WORKER_ERRORS.inc()
                    reason = f"{type(e).__name__}: {e}"[:300]
                    log.error("request failed", extra={"reason": reason})
                    if not isinstance(e, TRANSIENT) and self._exhausted(msg):
                        try:
                            self._give_up(msg, reason)
                        except Exception as recording_error:  # noqa: BLE001 - e.g. the broker is down right now
                            log.error(
                                "could not record an abandoned request, will retry",
                                extra={"reason": f"{type(recording_error).__name__}: {recording_error}"[:300]},
                            )
                        else:
                            REQUESTS.labels("dropped_poison").inc()
                            self._commit(msg)
                            continue
                    self._seek_back(msg)
                    stop.wait(self.retry_pause)
                    continue
                self._commit(msg)
        finally:
            self.consumer.close()
            log.info("worker stopped")

    def _exhausted(self, msg: Message) -> bool:
        """Count consecutive non-dependency failures of the same message; True once the bound is reached."""
        key = (msg.topic(), msg.partition(), msg.offset())
        if key != self._failing:
            self._failing, self._failures = key, 0
        self._failures += 1
        return self._failures >= self.max_attempts

    def _give_up(self, msg: Message, reason: str) -> None:
        """Record the failure of a request we are abandoning, but only if it is a validly signed request:
        an unsigned message must never be able to fail someone else's run. Only broker/database outages
        propagate (so the caller retries); anything else means there is nothing more to record."""
        log.error("request abandoned after repeated failures", extra={"reason": reason})
        try:
            event = json.loads(msg.value() or b"")
            contracts.validate("crawl.requested", event)
            if not signing.verify(event, self.deps.signing_keys):
                return
            failed = events.crawl_failed(
                event["runId"], event["correlationId"], event["source"], event["ecosystem"], reason, self.max_attempts
            )
        except Exception:  # noqa: BLE001 - not a verifiable request, or anything unexpected: nothing to record
            return
        try:
            self.publish(failed)
            self.deps.runs.mark_failed(event["runId"], reason, self.max_attempts)
        except TRANSIENT:
            raise
        except Exception:  # noqa: BLE001 - e.g. the run already finished; nothing more to record
            log.warning("could not record the failure", extra={"runId": event["runId"]})

    def _commit(self, msg: Message, tries: int = 3) -> None:
        """Commit with a few retries. Failing to commit is never fatal: the message is redelivered and the
        run is already recorded, so redelivery is a no-op; a later commit also covers this offset."""
        for attempt in range(1, tries + 1):
            try:
                self.consumer.commit(message=msg, asynchronous=False)
                return
            except KafkaException as e:
                log.warning("offset commit failed", extra={"reason": f"attempt {attempt}/{tries}: {e}"[:300]})
                time.sleep(min(0.2 * attempt, 1.0))

    def _seek_back(self, msg: Message, tries: int = 3) -> None:
        """Rewind to the failed message so it is redelivered. If the partition was revoked meanwhile, the
        new owner resumes from the last committed offset, so giving up on the seek is safe."""
        position = TopicPartition(str(msg.topic()), int(msg.partition() or 0), int(msg.offset() or 0))
        for attempt in range(1, tries + 1):
            try:
                self.consumer.seek(position)
                return
            except KafkaException as e:
                log.warning("seek failed", extra={"reason": f"attempt {attempt}/{tries}: {e}"[:300]})
                time.sleep(min(0.2 * attempt, 1.0))
