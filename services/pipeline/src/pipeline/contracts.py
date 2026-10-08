import json
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

# services/pipeline/src/pipeline/contracts.py -> repo root is four levels up.
CONTRACTS_DIR = Path(__file__).resolve().parents[4] / "packages" / "contracts"
SCHEMA_DIR = CONTRACTS_DIR / "events"
MODEL_DIR = CONTRACTS_DIR / "models"


class InvalidEvent(ValueError):
    pass


@cache
def _validator(path: Path) -> Draft202012Validator:
    return Draft202012Validator(json.loads(path.read_text()), format_checker=FormatChecker())


def _check(label: str, path: Path, doc: dict[str, Any]) -> None:
    error = next(iter(sorted(_validator(path).iter_errors(doc), key=lambda e: list(e.path))), None)
    if error:
        raise InvalidEvent(f"{label}: {'/'.join(map(str, error.path)) or '<root>'}: {error.message}")


def validate(event_type: str, event: dict[str, Any]) -> None:
    """Raise InvalidEvent unless the event matches its v1 schema."""
    _check(event_type, SCHEMA_DIR / f"{event_type}.v1.json", event)


def validate_model(name: str, doc: dict[str, Any]) -> None:
    """Raise InvalidEvent unless the canonical record matches its v1 schema."""
    _check(name, MODEL_DIR / f"{name}.v1.json", doc)
