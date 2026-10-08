"""Operator task: run a full sweep now, ignoring the interval. Use after a matcher change or an outage.
`task pipeline:correlate:sweep`."""

import logging

from .. import log
from . import config
from .process import Deps
from .store import Store
from .sweep import Sweep


def main() -> None:
    log.setup("correlator")
    settings = config.load()
    store = Store(settings.database_url)
    sweep = Sweep(Deps(store=store, limits=settings.limits))
    # Interval 0: due now, but a lease held by a running worker is still respected.
    if not sweep.maybe_start(0):
        raise SystemExit("a sweep is already running")
    while sweep.step():
        pass
    logging.getLogger("pipeline").info("sweep done")
    store.close()


main()
