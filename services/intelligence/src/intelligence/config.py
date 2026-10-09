import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    kafka_bootstrap: str
    model_url: str
    model_api_key: str
    max_attempts: int = 3
    model_timeout_seconds: float = 90
    lease_seconds: int = 180
    max_concurrent: int = 1


def load() -> Settings:
    url = os.environ.get("INTELLIGENCE_DATABASE_URL")
    if not url:
        raise RuntimeError("INTELLIGENCE_DATABASE_URL is required")
    return Settings(
        database_url=url,
        kafka_bootstrap=os.environ.get("INTELLIGENCE_KAFKA_BOOTSTRAP", "127.0.0.1:19092"),
        model_url=os.environ.get("INTELLIGENCE_MODEL_URL", "http://host.docker.internal:8000/v1"),
        model_api_key=os.environ.get("INTELLIGENCE_MODEL_API_KEY", ""),
        max_attempts=int(os.environ.get("INTELLIGENCE_MAX_ATTEMPTS", "3")),
        model_timeout_seconds=float(os.environ.get("INTELLIGENCE_MODEL_TIMEOUT_SECONDS", "90")),
        lease_seconds=int(os.environ.get("INTELLIGENCE_LEASE_SECONDS", "180")),
        max_concurrent=int(os.environ.get("INTELLIGENCE_MAX_CONCURRENT", "1")),
    )
