import uuid
from datetime import UTC, datetime
from typing import Any

from . import contracts

# Fixed namespace: eventId = uuid5(namespace, "<runId>:<type>"), so republishing after a crash
# produces the same eventId and consumers can dedupe on it.
_NS = uuid.UUID("5f0b1f3e-3c5d-4c7e-9a52-6d6a4f1d2b10")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _envelope(event_type: str, run_id: str, correlation_id: str) -> dict[str, Any]:
    return {
        "eventId": str(uuid.uuid5(_NS, f"{run_id}:{event_type}")),
        "type": event_type,
        "version": 1,
        "timestamp": _now(),
        "correlationId": correlation_id,
        "runId": run_id,
    }


def artifact_ingested(
    run_id: str,
    correlation_id: str,
    source: str,
    ecosystem: str,
    bucket: str,
    key: str,
    sha256: str,
    size: int,
    fetched_at: str,
) -> dict[str, Any]:
    event = {
        **_envelope("artifact.ingested", run_id, correlation_id),
        "source": source,
        "ecosystem": ecosystem,
        "artifact": {"bucket": bucket, "key": key, "sha256": sha256, "sizeBytes": size},
        "fetchedAt": fetched_at,
    }
    contracts.validate("artifact.ingested", event)
    return event


def crawl_failed(
    run_id: str, correlation_id: str, source: str, ecosystem: str, reason: str, attempts: int
) -> dict[str, Any]:
    event = {
        **_envelope("crawl.failed", run_id, correlation_id),
        "source": source,
        "ecosystem": ecosystem,
        "reason": reason[:500],
        "attempts": max(attempts, 1),
    }
    contracts.validate("crawl.failed", event)
    return event
