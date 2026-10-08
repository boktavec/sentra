import os
import signal
import threading

from prometheus_client import start_http_server

from . import config, log
from .imports import Imports
from .process import Deps
from .storage import make_client
from .worker import Worker


def main() -> None:
    logger = log.setup()
    settings = config.load()
    deps = Deps(
        imports=Imports(settings.database_url),
        s3=make_client(settings.s3_endpoint, settings.s3_access_key, settings.s3_secret_key),
        bucket=settings.s3_bucket,
        limits=settings.limits,
    )
    worker = Worker(deps, os.environ.get("PIPELINE_KAFKA_BOOTSTRAP", "127.0.0.1:19092"))
    start_http_server(int(os.environ.get("PIPELINE_METRICS_PORT", "9103")), addr="127.0.0.1")
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    logger.info("pipeline starting")
    worker.run(stop)
    deps.imports.close()


main()
