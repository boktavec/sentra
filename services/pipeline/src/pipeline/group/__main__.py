"""Grouper: poll for changed advisories and keep vulnerability_groups current. `--once` runs a single pass
(also the way to rebuild after a rule change: clear group_state, then run)."""

import logging
import os
import signal
import sys
import threading

import psycopg
from prometheus_client import start_http_server

from .. import log
from .run import run_once


def main() -> None:
    log.setup("grouper")
    url = os.environ.get("GROUPER_DATABASE_URL")
    if not url:
        raise RuntimeError("GROUPER_DATABASE_URL is required")
    poll = int(os.environ.get("GROUPER_POLL_SECONDS", "60"))
    logger = logging.getLogger("pipeline")
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    if "--once" not in sys.argv:
        start_http_server(int(os.environ.get("GROUPER_METRICS_PORT", "9106")), addr="127.0.0.1")
    logger.info("grouper starting")
    while not stop.is_set():
        try:
            with psycopg.connect(url, autocommit=True) as conn:
                if run_once(conn) is None:
                    logger.info("another grouper holds the lock")
        except Exception:
            logger.exception("group run failed")
            if "--once" in sys.argv:
                raise SystemExit(1) from None
        if "--once" in sys.argv:
            return
        stop.wait(poll)


main()
