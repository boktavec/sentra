import os
import re
from dataclasses import dataclass
from urllib.parse import urlparse


class Secret:
    """A credential that cannot leak through repr, str, logging or a dataclass dump. Read it with reveal()."""

    __slots__ = ("_value",)

    def __init__(self, value: str):
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "Secret(***)"

    __str__ = __repr__


@dataclass(frozen=True)
class Limits:
    """Fetch limits. Defaults are assumptions from the SENTRA-7 spec, validated against real downloads."""

    connect_timeout: float = 10.0
    read_timeout: float = 60.0
    # Budget for the whole download: every attempt and the backoff sleeps between them.
    total_timeout: float = 15 * 60.0
    max_bytes: int = 1024**3
    max_attempts: int = 5
    backoff_base: float = 1.0
    backoff_cap: float = 60.0

    @property
    def claim_lease_seconds(self) -> int:
        """Outlasts the download budget plus upload and database time, so a live worker keeps its claim."""
        return int(self.total_timeout) + 10 * 60

    @property
    def poll_interval_ms(self) -> int:
        """Kafka max.poll.interval.ms: one request can legitimately run for the whole lease."""
        return (self.claim_lease_seconds + 5 * 60) * 1000


@dataclass(frozen=True)
class Settings:
    database_url: str
    s3_endpoint: str
    s3_bucket: str
    s3_access_key: str
    s3_secret_key: str
    signing_keys: dict[str, bytes]
    osv_base_url: str = "https://osv-vulnerabilities.storage.googleapis.com"
    kev_url: str = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
    limits: Limits = Limits()
    github_token: Secret | None = None  # required only by ghsa runs; they fail before any request without it
    kafka_bootstrap: str = "127.0.0.1:19092"
    # Loopback by default; set CRAWLER_METRICS_HOST=0.0.0.0 in a container so Prometheus can scrape it.
    metrics_host: str = "127.0.0.1"
    metrics_port: int = 9102


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
    """Source URLs are operator config, never event data. HTTPS only, except loopback for tests."""
    parsed = urlparse(url)
    if parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")):
        return url.rstrip("/")
    raise RuntimeError("source URL must be https (http only for loopback)")


def parse_github_token(raw: str | None) -> Secret | None:
    """Unset or empty means "no token". Anything with whitespace or control characters is refused without
    echoing it: it would corrupt the Authorization header, and the value is a secret."""
    token = (raw or "").strip()
    if not token:
        return None
    if not re.fullmatch(r"[!-~]+", token):
        raise RuntimeError("CRAWLER_GITHUB_TOKEN must be a single token of printable ASCII characters")
    return Secret(token)


def _port(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    if not raw.isdigit() or not 0 < int(raw) < 65536:
        raise RuntimeError(f"{name} must be a port number, got {raw!r}")
    return int(raw)


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
        kev_url=check_source_url(os.environ.get("CRAWLER_KEV_URL", Settings.kev_url)),
        github_token=parse_github_token(os.environ.get("CRAWLER_GITHUB_TOKEN")),
        kafka_bootstrap=os.environ.get("CRAWLER_KAFKA_BOOTSTRAP", Settings.kafka_bootstrap),
        metrics_host=os.environ.get("CRAWLER_METRICS_HOST", Settings.metrics_host),
        metrics_port=_port("CRAWLER_METRICS_PORT", Settings.metrics_port),
    )
