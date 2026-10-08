"""The scheduled full re-match (ADR 0003): reconcile every project, a bounded batch per step, so the worker
polls Kafka between steps and event-driven work is never stuck behind it. It is the safety net for lost
events and the way to re-run after a matcher change. ponytail: lives in the worker until SENTRA-10
provides a scheduler."""

import logging
import time
from datetime import datetime

from . import metrics
from .process import Deps, reconcile_project

log = logging.getLogger("pipeline")


class Sweep:
    def __init__(self, deps: Deps):
        self.deps = deps
        self.active = False
        self._cursor: str | None = None
        self._started: datetime | None = None
        self._t0 = 0.0
        self._done = 0

    def update_age(self) -> None:
        last = self.deps.store.last_sweep()
        metrics.SWEEP_AGE.set(-1 if last is None else (self.deps.store.now() - last).total_seconds())

    def maybe_start(self, interval_seconds: int | None = None) -> bool:
        """Start a sweep if one is due (the configured interval unless given) and no other worker holds the lease."""
        if self.active:
            return True
        store, limits = self.deps.store, self.deps.limits
        interval = limits.sweep_interval_seconds if interval_seconds is None else interval_seconds
        if not store.claim_sweep(interval, limits.lease_seconds):
            return False
        self.active, self._cursor, self._done = True, None, 0
        self._started, self._t0 = store.now(), time.monotonic()
        log.info("sweep started", extra={"trigger": "sweep"})
        return True

    def step(self) -> bool:
        """Reconcile the next batch of projects. True while more remain."""
        store, limits = self.deps.store, self.deps.limits
        if not store.renew_sweep(limits.lease_seconds):
            self.active = False  # lease lost: another worker took over
            log.warning("sweep lease lost", extra={"trigger": "sweep"})
            return False
        projects = store.project_page(self._cursor, limits.sweep_batch)
        for project_id in projects:
            reconcile_project(self.deps, project_id, "sweep", {})
            self._cursor = project_id
            self._done += 1
        if len(projects) < limits.sweep_batch:
            store.finish_sweep(self._started or store.now())
            metrics.SWEEP_SECONDS.observe(time.monotonic() - self._t0)
            log.info("sweep finished", extra={"trigger": "sweep", "outcome": f"projects={self._done}"})
            self.active = False
            return False
        return True
