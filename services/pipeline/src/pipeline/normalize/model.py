from typing import Any

from .. import contracts

SCHEMA_VERSION = 1  # packages/contracts/models/vulnerability.v1.json


def validate(record: dict[str, Any]) -> None:
    """Raise InvalidEvent unless the record is a valid canonical vulnerability. Called before anything is persisted."""
    contracts.validate_model("vulnerability", record)
