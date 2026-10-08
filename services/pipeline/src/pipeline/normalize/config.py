import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Limits:
    """Normalization limits. Zip limits are about 4-9x the npm dump measured on 2026-10-08
    (230,171 entries, 368 MiB uncompressed, largest entry 1.1 MiB); the rest are assumptions (SENTRA-11 spec)."""

    max_artifact_bytes: int = 1024**3  # the crawler's own cap on a stored artifact
    max_entries: int = 1_000_000
    max_entry_bytes: int = 10 * 1024**2
    max_total_bytes: int = 2 * 1024**3
    batch_size: int = 500
    max_failure_rate: float = 0.01  # abort the run above this share of failed records...
    min_records_for_rate: int = 1000  # ...once at least this many were seen
    lease_seconds: int = 15 * 60  # renewed after every batch
    max_attempts: int = 5
    backoff_base: float = 1.0
    backoff_cap: float = 30.0


@dataclass(frozen=True)
class Settings:
    database_url: str
    s3_endpoint: str
    s3_bucket: str
    s3_access_key: str
    s3_secret_key: str
    limits: Limits = Limits()


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def load() -> Settings:
    return Settings(
        database_url=_required("NORMALIZER_DATABASE_URL"),
        s3_endpoint=_required("NORMALIZER_S3_ENDPOINT"),
        s3_bucket=os.environ.get("NORMALIZER_S3_BUCKET", "sentra-raw"),
        s3_access_key=_required("NORMALIZER_S3_ACCESS_KEY"),
        s3_secret_key=_required("NORMALIZER_S3_SECRET_KEY"),
        limits=Limits(
            max_entries=int(os.environ.get("NORMALIZER_MAX_ENTRIES", Limits.max_entries)),
            max_entry_bytes=int(os.environ.get("NORMALIZER_MAX_ENTRY_BYTES", Limits.max_entry_bytes)),
            max_total_bytes=int(os.environ.get("NORMALIZER_MAX_TOTAL_BYTES", Limits.max_total_bytes)),
            batch_size=int(os.environ.get("NORMALIZER_BATCH_SIZE", Limits.batch_size)),
        ),
    )
