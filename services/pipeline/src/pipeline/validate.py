import json
from typing import Any

# Verified 2026-10-08 (cyclonedx-python-lib and cyclonedx-cli docs via context7): the spec has
# versions 1.0 to 1.7 and JSON exists from 1.2. Older JSON files (1.2, 1.3) are rare, so they are
# rejected as unsupported.
SUPPORTED_SPEC_VERSIONS = frozenset({"1.4", "1.5", "1.6", "1.7"})


def load(data: bytes) -> tuple[dict[str, Any] | None, str | None]:
    """(document, None) for a supported CycloneDX JSON file, else (None, rejection reason code)."""
    try:
        doc = json.loads(data)
    except ValueError, RecursionError:  # ValueError covers bad UTF-8 and bad JSON; deep nesting recurses
        return None, "not_json"
    if not isinstance(doc, dict) or doc.get("bomFormat") != "CycloneDX":
        return None, "not_cyclonedx"
    if doc.get("specVersion") not in SUPPORTED_SPEC_VERSIONS:
        return None, "unsupported_version"
    return doc, None


def check(data: bytes) -> str | None:
    """None when `data` is a supported CycloneDX JSON document, else the rejection reason code."""
    return load(data)[1]
