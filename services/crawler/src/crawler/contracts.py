import json
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

# services/crawler/src/crawler/contracts.py -> repo root is four levels up.
SCHEMA_DIR = Path(__file__).resolve().parents[4] / "packages" / "contracts" / "events"


class InvalidEvent(ValueError):
    pass


@cache
def _validator(event_type: str, version: int) -> Draft202012Validator:
    schema = json.loads((SCHEMA_DIR / f"{event_type}.v{version}.json").read_text())
    return Draft202012Validator(schema, format_checker=FormatChecker())


def validate(event_type: str, event: dict[str, Any], version: int = 1) -> None:
    """Raise InvalidEvent unless the event matches its schema (used for inbound and outbound events)."""
    errors = sorted(_validator(event_type, version).iter_errors(event), key=lambda e: list(e.path))
    if errors:
        e = errors[0]
        raise InvalidEvent(f"{event_type}: {'/'.join(map(str, e.path)) or '<root>'}: {e.message}")
