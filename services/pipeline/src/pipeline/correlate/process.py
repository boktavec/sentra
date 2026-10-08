"""Event handlers. Events are wake-ups (ADR 0003): the database, not the event, says which tenant and
project to reconcile and what changed. Every handler is idempotent, so redelivery costs only time."""

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from .. import contracts
from . import metrics
from .config import Limits
from .reconcile import Result
from .store import Store

log = logging.getLogger("pipeline")

PARSED = "sbom.parsed"
NORMALIZED = "vulnerabilities.normalized"


@dataclass
class Deps:
    store: Store
    limits: Limits = field(default_factory=Limits)


def record(result: Result, trigger: str, seconds: float) -> None:
    """Metrics for one reconcile; `seconds` is the wall time including lock wait."""
    for outcome in ("created", "updated", "reopened", "resolved", "unchanged"):
        metrics.FINDINGS.labels(outcome).inc(getattr(result, outcome))
    for (quality, reason), n in result.quality.items():
        metrics.MATCHES.labels(quality, reason or "none").inc(n)
    metrics.UNMATCHABLE.inc(result.unmatchable)
    metrics.PROJECTS.labels(trigger).inc()
    metrics.LOCK_WAIT_SECONDS.observe(result.lock_wait)
    metrics.RECONCILE_SECONDS.observe(max(seconds - result.lock_wait, 0.0))


def reconcile_project(deps: Deps, project_id: str, trigger: str, extra: dict[str, Any]) -> Result:
    started = time.monotonic()
    result = deps.store.reconcile(project_id)
    record(result, trigger, time.monotonic() - started)
    log.info(
        "project reconciled",
        extra={**extra, "projectId": project_id, "trigger": trigger, "outcome": f"created={result.created} "
               f"updated={result.updated} reopened={result.reopened} resolved={result.resolved} "
               f"unchanged={result.unchanged}"},
    )  # fmt: skip
    return result


def handle_parsed(event: dict[str, Any], deps: Deps) -> str:
    """sbom.parsed -> reconcile that import's project. Outcomes: reconciled | skipped_duplicate |
    skipped_missing | skipped_stale | dropped_invalid. Raises only for infrastructure errors."""
    try:
        contracts.validate(PARSED, event)
    except contracts.InvalidEvent as e:
        log.warning("event dropped", extra={"outcome": "dropped_invalid", "reason": str(e)})
        return "dropped_invalid"
    import_id, correlation_id = event["importId"], event["correlationId"]
    extra = {"correlationId": correlation_id, "importId": import_id}
    # Tenant and project come from the row the pipeline wrote, never from the event.
    row = deps.store.import_row(import_id)
    if row is None:
        return "skipped_missing"
    if row.status != "parsed":
        return "skipped_stale"  # reprocessed or replaced since; the next sbom.parsed covers it
    run_id = deps.store.claim_run(import_id, row, correlation_id, deps.limits.lease_seconds)
    if run_id is None:
        return "skipped_duplicate"
    try:
        result = reconcile_project(deps, row.project_id, PARSED, {**extra, "tenantId": row.org_id})
    except Exception as e:
        deps.store.fail_run(run_id, f"{type(e).__name__}: {e}")
        raise
    deps.store.finish_run(run_id, result)
    return "reconciled"


def handle_normalized(event: dict[str, Any], deps: Deps) -> str:
    """vulnerabilities.normalized -> reconcile every project touched by advisories changed since the
    watermark, then advance it. A crash part-way repeats some reconciles, which are no-ops."""
    try:
        contracts.validate(NORMALIZED, event)
    except contracts.InvalidEvent as e:
        log.warning("event dropped", extra={"outcome": "dropped_invalid", "reason": str(e)})
        return "dropped_invalid"
    extra = {"correlationId": event["correlationId"]}
    store = deps.store
    high = store.advisory_high_water()
    if high is None:
        return "skipped_empty"
    for project_id in store.projects_affected_by(store.watermark(), high, deps.limits.watermark_overlap_seconds):
        reconcile_project(deps, project_id, NORMALIZED, extra)
    store.set_watermark(high)
    return "reconciled"


def handle(event: dict[str, Any], deps: Deps) -> str:
    """Dispatch on the event's own `type`, so the topic name is only transport."""
    kind = event.get("type")
    if kind == PARSED:
        outcome = handle_parsed(event, deps)
    elif kind == NORMALIZED:
        outcome = handle_normalized(event, deps)
    else:
        log.warning("event dropped", extra={"outcome": "dropped_invalid", "reason": f"unknown type {kind!r}"})
        outcome = "dropped_invalid"
    metrics.EVENTS.labels(str(kind)[:64], outcome).inc()
    return outcome
