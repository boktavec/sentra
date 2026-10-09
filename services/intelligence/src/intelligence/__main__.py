import json
import logging
import os
import signal
import threading
import time

from confluent_kafka import Consumer, KafkaError
from prometheus_client import Counter, Gauge, Histogram, start_http_server

from .config import load
from .events import valid_requested
from .model import ModelClient, ModelError
from .store import Store

log = logging.getLogger("intelligence")
OUTCOMES = Counter("investigation_worker_outcomes_total", "Worker outcomes", ["outcome"])
MODEL_SECONDS = Histogram("investigation_model_duration_seconds", "Local model call duration")
QUEUE_AGE = Gauge("investigation_queue_oldest_age_seconds", "Oldest queued investigation age")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = load()
    if settings.max_concurrent < 1 or settings.lease_seconds <= settings.model_timeout_seconds:
        raise ValueError("invalid worker capacity or lease configuration")
    store = Store(settings.database_url)
    model = ModelClient(settings.model_url, settings.model_api_key, settings.model_timeout_seconds)
    consumer = Consumer(
        {
            "bootstrap.servers": settings.kafka_bootstrap,
            "group.id": "intelligence",
            "enable.auto.commit": False,
            "auto.offset.reset": "earliest",
        }
    )
    consumer.subscribe(["investigation.requested"])
    start_http_server(int(os.environ.get("INTELLIGENCE_METRICS_PORT", "9106")), addr="0.0.0.0")  # noqa: S104
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    try:
        while not stop.is_set():
            # Events wake the worker. The due-row query also heals a lost or already committed event.
            try:
                msg = consumer.poll(1.0)
            except Exception:
                log.exception("broker poll failed")
                msg = None
            if msg is not None and msg.error() is None:
                try:
                    event = json.loads(msg.value() or b"")
                    if not valid_requested(event):
                        OUTCOMES.labels("invalid_event").inc()
                except ValueError, TypeError:
                    OUTCOMES.labels("invalid_event").inc()
                try:
                    consumer.commit(message=msg, asynchronous=False)
                except Exception:
                    log.warning("broker commit failed; duplicate delivery is safe")
            elif msg is not None:
                error = msg.error()
                if error is not None and error.code() != KafkaError.UNKNOWN_TOPIC_OR_PART:
                    log.warning("broker unavailable: %s", error)
            try:
                QUEUE_AGE.set(store.queue_age_seconds())
                if not store.acquire_slot(settings.max_concurrent):
                    continue
                try:
                    run = store.claim(settings.lease_seconds, settings.max_attempts)
                    if run is None:
                        continue
                    started = time.monotonic()
                    try:
                        draft = model.draft(run.model_id, run.context)
                        if store.complete(run, draft):
                            OUTCOMES.labels("completed").inc()
                            log.info("investigation completed id=%s org=%s", run.id, run.org_id)
                    except ModelError as exc:
                        state = store.fail(run, exc.code, exc.retryable, settings.max_attempts)
                        OUTCOMES.labels(state).inc()
                        log.warning("investigation %s id=%s org=%s code=%s", state, run.id, run.org_id, exc.code)
                    except Exception:
                        state = store.fail(run, "processing_error", True, settings.max_attempts)
                        OUTCOMES.labels(state).inc()
                        log.exception("investigation processing error id=%s org=%s", run.id, run.org_id)
                    finally:
                        MODEL_SECONDS.observe(time.monotonic() - started)
                finally:
                    store.release_slot()
            except Exception:
                OUTCOMES.labels("worker_error").inc()
                log.exception("worker iteration failed")
                stop.wait(2)
    finally:
        consumer.close()
        model.close()
        store.close()


if __name__ == "__main__":
    main()
