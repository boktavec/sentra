import json
import logging
import sys
from datetime import UTC, datetime


class JsonFormatter(logging.Formatter):
    """One JSON object per line, per packages/contracts/logging.md."""

    def __init__(self, service: str = "pipeline"):
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": {"WARNING": "warn"}.get(record.levelname, record.levelname.lower()),
            "service": self.service,
            "message": record.getMessage(),
        }
        for field in ("correlationId", "importId", "artifactSha256", "ecosystem", "outcome", "reason"):
            if hasattr(record, field):
                entry[field] = getattr(record, field)
        return json.dumps(entry)


def setup(service: str = "pipeline") -> logging.Logger:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service))
    log = logging.getLogger("pipeline")
    log.handlers[:] = [handler]
    log.setLevel(logging.INFO)
    return log
