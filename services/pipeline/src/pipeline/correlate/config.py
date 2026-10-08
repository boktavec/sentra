import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Limits:
    lease_seconds: int = 15 * 60  # for an import run; the sweep renews its lease after every batch
    sweep_interval_seconds: int = 24 * 3600  # assumed; bounds how long a lost event can leave findings stale
    sweep_batch: int = 25  # projects per step; the worker polls Kafka between steps
    # `vulnerabilities.updated_at` is the normalizer's transaction start time, so a batch can commit after
    # a later one was seen. Looking back this far re-reconciles a few projects, which is a no-op.
    watermark_overlap_seconds: int = 300
    max_attempts: int = 5  # unexpected errors per event before it is given up on (the sweep heals)


@dataclass(frozen=True)
class Settings:
    database_url: str
    kafka_bootstrap: str
    limits: Limits = Limits()


def load() -> Settings:
    url = os.environ.get("CORRELATOR_DATABASE_URL")
    if not url:
        raise RuntimeError("CORRELATOR_DATABASE_URL is required")
    return Settings(
        database_url=url,
        kafka_bootstrap=os.environ.get("CORRELATOR_KAFKA_BOOTSTRAP", "127.0.0.1:19092"),
        limits=Limits(
            sweep_interval_seconds=int(
                os.environ.get("CORRELATOR_SWEEP_INTERVAL_SECONDS", Limits.sweep_interval_seconds)
            ),
            sweep_batch=int(os.environ.get("CORRELATOR_SWEEP_BATCH", Limits.sweep_batch)),
        ),
    )
