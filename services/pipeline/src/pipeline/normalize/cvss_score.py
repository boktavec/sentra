"""Derive a standard CVSS base score from source vectors, independent of tenant risk priority."""

import logging
from collections.abc import Mapping, Sequence
from typing import Any

from cvss import CVSS3, CVSS4
from cvss.exceptions import CVSSError

log = logging.getLogger("pipeline")


def score(severities: Sequence[Mapping[str, Any]]) -> tuple[float | None, str | None]:
    """Prefer a valid v4 vector, then v3.1, then v3.0. Invalid vectors do not hide a finding."""
    candidates: list[tuple[int, str, str]] = []
    for entry in severities:
        vector = entry.get("vector")
        if not isinstance(vector, str):
            continue
        if vector.startswith("CVSS:4.0/"):
            candidates.append((3, "4.0", vector))
        elif vector.startswith("CVSS:3.1/"):
            candidates.append((2, "3.1", vector))
        elif vector.startswith("CVSS:3.0/"):
            candidates.append((1, "3.0", vector))
    for _, version, vector in sorted(candidates, reverse=True):
        try:
            parsed = CVSS4(vector) if version == "4.0" else CVSS3(vector)
            base = parsed.scores()[0]
            if base is not None:
                return float(base), version
        except CVSSError, ValueError, TypeError:
            log.warning("invalid CVSS vector", extra={"cvssVersion": version})
    return None, None
