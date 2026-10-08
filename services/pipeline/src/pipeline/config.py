import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Limits:
    """Processing limits. Defaults are assumptions from the SENTRA-5 spec."""

    max_bytes: int = 10 * 1024 * 1024
    max_components: int = 50_000  # assumed; validate against a large real SBOM (SENTRA-6 spec)
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
        database_url=_required("PIPELINE_DATABASE_URL"),
        s3_endpoint=_required("PIPELINE_S3_ENDPOINT"),
        s3_bucket=os.environ.get("PIPELINE_S3_BUCKET", "sentra-raw"),
        s3_access_key=_required("PIPELINE_S3_ACCESS_KEY"),
        s3_secret_key=_required("PIPELINE_S3_SECRET_KEY"),
        limits=Limits(
            max_bytes=int(os.environ.get("PIPELINE_MAX_SBOM_BYTES", Limits.max_bytes)),
            max_components=int(os.environ.get("PIPELINE_MAX_COMPONENTS", Limits.max_components)),
        ),
    )
