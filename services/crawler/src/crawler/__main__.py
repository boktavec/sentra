import os
import signal
import threading

from prometheus_client import start_http_server

from . import config, log
from .ingest import Deps
from .runs import Runs
from .storage import ArtifactStore, make_client
from .worker import Worker


def main() -> None:
    logger = log.setup()
    settings = config.load()
    s3 = make_client(settings.s3_endpoint, settings.s3_access_key, settings.s3_secret_key)
    if os.environ.get("CRAWLER_CREATE_BUCKET") == "1":  # local dev only; deployed buckets are provisioned
        try:
            s3.head_bucket(Bucket=settings.s3_bucket)
        except Exception:  # noqa: BLE001 - head_bucket raises a generic ClientError when missing
            s3.create_bucket(Bucket=settings.s3_bucket)
    deps = Deps(
        runs=Runs.connect(settings.database_url),
        store=ArtifactStore(s3, settings.s3_bucket),
        publish=lambda event: None,  # replaced by the worker's Kafka producer
        signing_keys=settings.signing_keys,
        osv_base_url=settings.osv_base_url,
        limits=settings.limits,
    )
    worker = Worker(deps, settings.kafka_bootstrap)
    start_http_server(settings.metrics_port, addr=settings.metrics_host)
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    logger.info("crawler starting")
    worker.run(stop)


if __name__ == "__main__":
    main()
