"""Validate the small wake-up envelope before acknowledging it.

Event IDs and tenant fields are never used for database authorization; the
investigation row is authoritative. Invalid messages are acknowledged so they
cannot poison the partition, while the database sweep still finds valid work.
"""

from datetime import datetime
from uuid import UUID


def valid_requested(value: object) -> bool:
    if not isinstance(value, dict) or set(value) != {
        "eventId",
        "type",
        "version",
        "timestamp",
        "correlationId",
        "investigationId",
        "orgId",
        "projectId",
    }:
        return False
    if value.get("type") != "investigation.requested" or value.get("version") != 1:
        return False
    correlation = value.get("correlationId")
    if not isinstance(correlation, str) or not 1 <= len(correlation) <= 128:
        return False
    if not all(c.isascii() and (c.isalnum() or c in "._-") for c in correlation):
        return False
    try:
        for key in ("eventId", "investigationId", "orgId", "projectId"):
            UUID(value[key])
        timestamp = value["timestamp"]
        return (
            isinstance(timestamp, str) and datetime.fromisoformat(timestamp.replace("Z", "+00:00")).tzinfo is not None
        )
    except ValueError, TypeError, AttributeError, KeyError:
        return False
