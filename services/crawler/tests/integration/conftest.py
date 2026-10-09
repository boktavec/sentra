"""Integration fixtures: real Postgres and an S3 API (see `task stack:up`), plus the fake OSV server.

Defaults match infra/docker/.env.example; override with TEST_ADMIN_DATABASE_URL / TEST_S3_ENDPOINT.
Each session gets its own throwaway database and bucket, so nothing touches real data.
"""

import os
import threading
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

from crawler import signing
from crawler.config import Limits
from crawler.ingest import Deps
from crawler.runs import Runs
from crawler.storage import ArtifactStore, make_client

MIGRATIONS = Path(__file__).resolve().parents[4] / "apps" / "api" / "migrations"
ADMIN_URL = os.environ.get("TEST_ADMIN_DATABASE_URL", "postgresql://sentra:sentra@localhost:5440/sentra")
S3_ENDPOINT = os.environ.get("TEST_S3_ENDPOINT", "http://localhost:8333")
S3_KEYS = ("sentra-dev", "sentra-dev-secret")
KEYS = {"k1": b"integration-secret"}
CRAWLER_PASSWORD = "crawler-test-pw"


@pytest.fixture(scope="session")
def database():
    """A scratch database with every migration applied; yields (admin_url, crawler_role_url)."""
    name = f"crawler_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    admin_url = make_conninfo(ADMIN_URL, dbname=name)
    with psycopg.connect(admin_url, autocommit=True) as conn:
        for file in sorted(MIGRATIONS.glob("*.sql")):
            conn.execute(file.read_text())  # type: ignore[arg-type]
        conn.execute(sql.SQL("ALTER ROLE sentra_crawler LOGIN PASSWORD {}").format(sql.Literal(CRAWLER_PASSWORD)))
    crawler_url = make_conninfo(admin_url, user="sentra_crawler", password=CRAWLER_PASSWORD)
    yield admin_url, crawler_url
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest.fixture(scope="session")
def bucket():
    s3 = make_client(S3_ENDPOINT, *S3_KEYS)
    name = f"crawler-test-{uuid.uuid4().hex[:8]}"
    s3.create_bucket(Bucket=name)
    yield s3, name
    for obj in s3.list_objects_v2(Bucket=name).get("Contents", []):
        s3.delete_object(Bucket=name, Key=obj["Key"])
    s3.delete_bucket(Bucket=name)


@pytest.fixture
def admin(database):
    """Admin connection to the scratch DB; truncates runs before each test."""
    with psycopg.connect(database[0], autocommit=True) as conn:
        conn.execute("TRUNCATE ingestion_runs")
        yield conn


@pytest.fixture
def clean_bucket(bucket):
    s3, name = bucket
    for obj in s3.list_objects_v2(Bucket=name).get("Contents", []):
        s3.delete_object(Bucket=name, Key=obj["Key"])
    return s3, name


class Harness:
    """Wires Deps against the real services and records what was published."""

    def __init__(self, database, bucket, osv, tmp_path):
        self.s3, self.bucket = bucket
        self.crawler_url = database[1]
        self.osv = osv
        self.published: list[dict] = []
        self.publish_failures = 0  # next N publishes raise, simulating a broker outage
        self._lock = threading.Lock()
        self.tmp_path = tmp_path
        self.limits = Limits(read_timeout=2, connect_timeout=1, max_attempts=3, backoff_base=0.01, backoff_cap=0.02)

    def publish(self, event: dict) -> None:
        with self._lock:
            if self.publish_failures:
                self.publish_failures -= 1
                raise ConnectionError("broker unavailable")
            self.published.append(event)

    def deps(self) -> Deps:
        """A fresh Deps (and database connection), as a separate worker would have."""
        return Deps(
            runs=Runs.connect(self.crawler_url),
            store=ArtifactStore(self.s3, self.bucket),
            publish=self.publish,
            signing_keys=KEYS,
            osv_base_url=self.osv.base_url,
            kev_url=self.osv.base_url + "/kev.json",
            limits=self.limits,
            tmp_dir=str(self.tmp_path),
        )

    def objects(self) -> list[str]:
        return [o["Key"] for o in self.s3.list_objects_v2(Bucket=self.bucket).get("Contents", [])]


@pytest.fixture
def harness(database, clean_bucket, osv, admin, tmp_path):
    return Harness(database, clean_bucket, osv, tmp_path)


def make_request(run_id: str | None = None, ecosystem: str = "npm", key_id: str = "k1", **over) -> dict:
    event = {
        "eventId": str(uuid.uuid4()),
        "type": "crawl.requested",
        "version": 1,
        "timestamp": "2026-10-07T12:00:00Z",
        "correlationId": "it-corr-1",
        "runId": run_id or str(uuid.uuid4()),
        "source": "osv",
        "ecosystem": ecosystem,
        "keyId": key_id,
    }
    event.update(over)
    event["signature"] = signing.sign(event, KEYS.get(key_id, b"unknown"))
    return event
