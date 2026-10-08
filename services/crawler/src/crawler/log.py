import json
import logging
import sys
from datetime import UTC, datetime


class JsonFormatter(logging.Formatter):
    """One JSON object per line, per packages/contracts/logging.md."""

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": {"WARNING": "warn"}.get(record.levelname, record.levelname.lower()),
            "service": "crawler",
            "message": record.getMessage(),
        }
        for field in ("correlationId", "runId", "reason", "source", "ecosystem"):
            if hasattr(record, field):
                entry[field] = getattr(record, field)
        return json.dumps(entry)


def setup() -> logging.Logger:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    log = logging.getLogger("crawler")
    log.handlers[:] = [handler]
    log.setLevel(logging.INFO)
    return log
