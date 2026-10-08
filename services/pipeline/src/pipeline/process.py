import hashlib
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from . import contracts, events, parse, validate
from .config import Limits
from .imports import Imports
from .metrics import DEPENDENCIES, RETRIES, VALIDATION_SECONDS, VALIDATIONS
from .storage import read_capped

log = logging.getLogger("pipeline")


@dataclass
class Deps:
    imports: Imports
    s3: Any
    bucket: str
    limits: Limits = field(default_factory=Limits)
    sleep: Callable[[float], None] = time.sleep
    # Sends sbom.parsed; None in tools that only validate.
    publish: Callable[[dict[str, Any]], None] | None = None


def _attempt(import_id: str, deps: Deps) -> str:
    row = deps.imports.get(import_id)
    if row is None:
        return "skipped_missing"
    if row.status != "uploaded":
        return "skipped_duplicate"
    # The object key comes from the row the API wrote, never from the event.
    fetched = read_capped(deps.s3, deps.bucket, row.object_key, deps.limits.max_bytes)
    if fetched.data is None:
        return _reject(deps, import_id, "size", fetched.size, None)
    sha256 = hashlib.sha256(fetched.data).hexdigest()
    doc, reason = validate.load(fetched.data)
    if doc is None:
        return _reject(deps, import_id, reason, fetched.size, sha256)
    try:
        parsed = parse.parse(doc, deps.limits.max_components)
    except parse.TooManyComponents:
        return _reject(deps, import_id, "too_many_components", fetched.size, sha256)
    if not parsed.dependencies:
        return _reject(deps, import_id, "no_components", fetched.size, sha256)
    stored = deps.imports.store_parsed(
        row, size=len(fetched.data), sha256=sha256, dependencies=parsed.dependencies, skipped=parsed.skipped
    )
    if not stored:
        return "skipped_duplicate"
    DEPENDENCIES.observe(len(parsed.dependencies))
    return "parsed"


def _reject(deps: Deps, import_id: str, reason: str | None, size: int | None, sha256: str | None) -> str:
    done = deps.imports.finish(import_id, status="rejected", reason=reason, size=size or None, sha256=sha256)
    return "rejected" if done else "skipped_duplicate"


def _run(import_id: str, deps: Deps, extra: dict[str, str]) -> str:
    """Retry storage and database failures with backoff, then record processing_failed (ADR 0002)."""
    limits = deps.limits
    for attempt in range(1, limits.max_attempts + 1):
        try:
            return _attempt(import_id, deps)
        except Exception as e:
            log.warning("validation attempt failed", extra={**extra, "reason": f"{type(e).__name__}: {e}"})
            if attempt < limits.max_attempts:
                RETRIES.inc()
                deps.sleep(min(limits.backoff_base * 2 ** (attempt - 1), limits.backoff_cap))
    # If recording the failure also raises, it propagates and the offset stays uncommitted.
    done = deps.imports.finish(import_id, status="rejected", reason="processing_failed", size=None, sha256=None)
    return "failed" if done else "skipped_duplicate"


def _announce(import_id: str, correlation_id: str, deps: Deps) -> None:
    """Publish sbom.parsed for a parsed import. Called after the parse commit and again on every
    redelivery of an already-parsed import, so a crash between commit and publish is recovered; the eventId
    is stable, so consumers dedupe the repeat."""
    if deps.publish is None:
        return
    row = deps.imports.get(import_id)
    if row is None or row.status != "parsed":
        return
    deps.publish(events.sbom_parsed(row.id, row.org_id, row.project_id, correlation_id, row.dependency_count or 0))


def handle(event: dict[str, Any], deps: Deps) -> str:
    """Process one sbom.uploaded. Returns the outcome:
    dropped_invalid | skipped_missing | skipped_duplicate | parsed | rejected | failed.
    Exceptions only escape when the failure result itself could not be recorded, or sbom.parsed could not
    be published, so the caller does not commit the offset and the event is redelivered."""
    try:
        contracts.validate("sbom.uploaded", event)
    except contracts.InvalidEvent as e:
        log.warning("event dropped", extra={"outcome": "dropped_invalid", "reason": str(e)})
        VALIDATIONS.labels("dropped_invalid").inc()
        return "dropped_invalid"
    extra = {"correlationId": event["correlationId"], "importId": event["importId"]}
    started = time.monotonic()
    outcome = _run(event["importId"], deps, extra)
    if outcome in ("parsed", "skipped_duplicate"):
        _announce(event["importId"], event["correlationId"], deps)
    VALIDATION_SECONDS.observe(time.monotonic() - started)
    VALIDATIONS.labels(outcome).inc()
    log.info("sbom handled", extra={**extra, "outcome": outcome})
    return outcome
