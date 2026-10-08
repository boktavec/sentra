import uuid
from datetime import UTC, datetime
from typing import Any

from . import contracts

# Fixed namespace: eventId = uuid5(namespace, "<subject id>:<type>"), so republishing after a crash
# produces the same eventId and consumers can dedupe on it.
EVENT_NS = uuid.UUID("5f0b1f3e-3c5d-4c7e-9a52-6d6a4f1d2b10")


def sbom_parsed(
    import_id: str, org_id: str, project_id: str, correlation_id: str, dependency_count: int
) -> dict[str, Any]:
    event = {
        "eventId": str(uuid.uuid5(EVENT_NS, f"{import_id}:sbom.parsed")),
        "type": "sbom.parsed",
        "version": 1,
        "timestamp": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "correlationId": correlation_id,
        "importId": import_id,
        "orgId": org_id,
        "projectId": project_id,
        "dependencyCount": dependency_count,
    }
    contracts.validate("sbom.parsed", event)
    return event
