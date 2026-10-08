import os
import signal
import threading

from prometheus_client import start_http_server

from .. import log
from . import config
from .process import Deps
from .store import Store
from .worker import Worker


def main() -> None:
    logger = log.setup("correlator")
    settings = config.load()
    deps = Deps(store=Store(settings.database_url), limits=settings.limits)
    worker = Worker(deps, settings.kafka_bootstrap)
    start_http_server(int(os.environ.get("CORRELATOR_METRICS_PORT", "9105")), addr="127.0.0.1")
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    logger.info("correlator starting")
    worker.run(stop)
    deps.store.close()


main()
