import os
import signal
import threading

from prometheus_client import start_http_server

from .. import log
from ..storage import make_client
from . import config
from .process import Deps
from .store import Store
from .worker import Worker


def main() -> None:
    logger = log.setup("normalizer")
    settings = config.load()
    deps = Deps(
        store=Store(settings.database_url),
        s3=make_client(settings.s3_endpoint, settings.s3_access_key, settings.s3_secret_key),
        bucket=settings.s3_bucket,
        publish=lambda event: None,  # replaced by the worker's Kafka producer
        limits=settings.limits,
    )
    worker = Worker(deps, os.environ.get("NORMALIZER_KAFKA_BOOTSTRAP", "127.0.0.1:19092"))
    start_http_server(int(os.environ.get("NORMALIZER_METRICS_PORT", "9104")), addr="127.0.0.1")
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    logger.info("normalizer starting")
    worker.run(stop)
    deps.store.close()


main()
