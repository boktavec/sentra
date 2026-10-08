import os
from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class Limits:
    """Fetch limits. Defaults are assumptions from the SENTRA-7 spec, validated against real downloads."""

    connect_timeout: float = 10.0
    read_timeout: float = 60.0
    total_timeout: float = 15 * 60.0
    max_bytes: int = 1024**3
    max_attempts: int = 5
    backoff_base: float = 1.0
    backoff_cap: float = 60.0
    # Longer than total_timeout plus upload, so a live worker never loses its claim mid-run.
    claim_lease_seconds: int = 30 * 60


@dataclass(frozen=True)
class Settings:
    database_url: str
    s3_endpoint: str
    s3_bucket: str
    s3_access_key: str
    s3_secret_key: str
    signing_keys: dict[str, bytes]
    osv_base_url: str = "https://osv-vulnerabilities.storage.googleapis.com"
    limits: Limits = Limits()


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def parse_signing_keys(raw: str) -> dict[str, bytes]:
    """`k1=secret1,k2=secret2` -> {"k1": b"secret1", ...}. Several keys let rotation overlap."""
    keys: dict[str, bytes] = {}
    for part in raw.split(","):
        key_id, sep, secret = part.strip().partition("=")
        if not sep or not key_id or not secret:
            raise RuntimeError("CRAWLER_SIGNING_KEYS must look like k1=secret1,k2=secret2")
        keys[key_id] = secret.encode()
    return keys


def check_source_url(url: str) -> str:
    """The source base URL is operator config, never event data. HTTPS only, except loopback for tests."""
    parsed = urlparse(url)
    if parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")):
        return url.rstrip("/")
    raise RuntimeError("OSV base URL must be https (http only for loopback)")


def load() -> Settings:
    base = check_source_url(os.environ.get("CRAWLER_OSV_BASE_URL", Settings.osv_base_url))
    return Settings(
        database_url=_required("CRAWLER_DATABASE_URL"),
        s3_endpoint=_required("CRAWLER_S3_ENDPOINT"),
        s3_bucket=os.environ.get("CRAWLER_S3_BUCKET", "sentra-raw"),
        s3_access_key=_required("CRAWLER_S3_ACCESS_KEY"),
        s3_secret_key=_required("CRAWLER_S3_SECRET_KEY"),
        signing_keys=parse_signing_keys(_required("CRAWLER_SIGNING_KEYS")),
        osv_base_url=base,
    )
