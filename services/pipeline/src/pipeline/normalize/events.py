import uuid
from datetime import UTC, datetime
from typing import Any

from .. import contracts

# Fixed namespace: eventId = uuid5(namespace, "<runId>:<type>"), so republishing after a crash
# produces the same eventId and consumers can dedupe on it.
_NS = uuid.UUID("5f0b1f3e-3c5d-4c7e-9a52-6d6a4f1d2b10")


def vulnerabilities_normalized(
    run_id: str,
    correlation_id: str,
    source: str,
    ecosystem: str,
    artifact_sha256: str,
    adapter_version: int,
    upserted: int,
    unchanged: int,
    quarantined: int,
) -> dict[str, Any]:
    event = {
        "eventId": str(uuid.uuid5(_NS, f"{run_id}:vulnerabilities.normalized")),
        "type": "vulnerabilities.normalized",
        "version": 1,
        "timestamp": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "correlationId": correlation_id,
        "source": source,
        "ecosystem": ecosystem,
        "artifactSha256": artifact_sha256,
        "adapterVersion": adapter_version,
        "counts": {"upserted": upserted, "unchanged": unchanged, "quarantined": quarantined},
    }
    contracts.validate("vulnerabilities.normalized", event)
    return event
