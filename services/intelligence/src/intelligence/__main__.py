import json
import logging
import os
import signal
import threading
import time

from confluent_kafka import Consumer, KafkaError
from prometheus_client import Counter, Gauge, Histogram, start_http_server

from .agent import Attempt, Investigator
from .config import Settings, load
from .errors import LeaseLost, RunError
from .events import valid_requested
from .model import ModelClient
from .store import Run, Store
from .tools import ToolClient, load_tool_specs

log = logging.getLogger("intelligence")
OUTCOMES = Counter("investigation_worker_outcomes_total", "Worker outcomes", ["outcome"])
MODEL_SECONDS = Histogram("investigation_model_duration_seconds", "Local model call duration")
QUEUE_AGE = Gauge("investigation_queue_oldest_age_seconds", "Oldest queued investigation age")
TOOL_ROUNDS = Histogram(
    "investigation_tool_rounds", "Model rounds per completed prompt version 2 run", buckets=(1, 2, 3, 4)
)

# Failure codes that get their own outcome label, so tool trouble is visible next to the state counts.
TOOL_OUTCOMES = {"tool_unavailable", "tool_unauthorized", "deadline_exceeded"}


def execute(run: Run, settings: Settings, store: Store, model: ModelClient, investigator: Investigator) -> None:
    """Runs one claimed attempt to a stored result. Prompt version 1 is the single call queued before SENTRA-18."""
    started = time.monotonic()
    deadline = started + settings.attempt_deadline_seconds
    try:
        if run.prompt_version == 1:
            draft = model.draft(run.model_id, run.context)
        else:
            attempt = Attempt(run.id, run.lease_owner, run.attempts, run.model_id, run.context)
            draft, rounds = investigator.investigate(
                attempt, lambda: store.renew_lease(run, settings.lease_seconds), deadline
            )
            TOOL_ROUNDS.observe(rounds)
        if store.complete(run, draft):
            OUTCOMES.labels("completed").inc()
            log.info("investigation completed id=%s org=%s", run.id, run.org_id)
    except LeaseLost:
        OUTCOMES.labels("lease_lost").inc()
        log.warning("investigation lease lost id=%s org=%s; stopping without a write", run.id, run.org_id)
    except RunError as exc:
        state = store.fail(run, exc.code, exc.retryable, settings.max_attempts)
        OUTCOMES.labels(state).inc()
        if exc.code in TOOL_OUTCOMES:
            OUTCOMES.labels(exc.code).inc()
        log.warning("investigation %s id=%s org=%s code=%s", state, run.id, run.org_id, exc.code)
    except Exception:
        state = store.fail(run, "processing_error", True, settings.max_attempts)
        OUTCOMES.labels(state).inc()
        log.exception("investigation processing error id=%s org=%s", run.id, run.org_id)
    finally:
        MODEL_SECONDS.observe(time.monotonic() - started)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = load()
    store = Store(settings.database_url)
    model = ModelClient(settings.model_url, settings.model_api_key, settings.model_timeout_seconds)
    tools = ToolClient(settings.tools_url, settings.tools_token, settings.tool_timeout_seconds)
    investigator = Investigator(settings, model, tools, load_tool_specs(settings.contracts_dir))
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
                    run = store.claim(settings.lease_seconds, settings.max_attempts, settings.attempt_deadline_seconds)
                    if run is not None:
                        execute(run, settings, store, model, investigator)
                finally:
                    store.release_slot()
            except Exception:
                OUTCOMES.labels("worker_error").inc()
                log.exception("worker iteration failed")
                stop.wait(2)
    finally:
        consumer.close()
        model.close()
        tools.close()
        store.close()


if __name__ == "__main__":
    main()
