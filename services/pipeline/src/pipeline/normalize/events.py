import uuid
from datetime import UTC, datetime
from typing import Any

from .. import contracts
from ..events import EVENT_NS


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
        "eventId": str(uuid.uuid5(EVENT_NS, f"{run_id}:vulnerabilities.normalized")),
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
