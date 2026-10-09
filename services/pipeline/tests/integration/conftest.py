"""Integration fixtures: real Postgres and an S3 API (see `task stack:up`).

Defaults match infra/docker/.env.example; override with TEST_ADMIN_DATABASE_URL / TEST_S3_ENDPOINT.
Each session gets its own throwaway database and bucket, so nothing touches real data.
"""

import hashlib
import os
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import psycopg
import pytest
from correlate_support import World
from normalize_support import Env
from psycopg import sql
from psycopg.conninfo import make_conninfo

from pipeline.config import Limits
from pipeline.imports import Imports
from pipeline.process import Deps
from pipeline.storage import make_client

MIGRATIONS = Path(__file__).resolve().parents[4] / "apps" / "api" / "migrations"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
ADMIN_URL = os.environ.get("TEST_ADMIN_DATABASE_URL", "postgresql://sentra:sentra@localhost:5440/sentra")
S3_ENDPOINT = os.environ.get("TEST_S3_ENDPOINT", "http://localhost:8333")
S3_KEYS = ("sentra-dev", "sentra-dev-secret")
PIPELINE_PASSWORD = "pipeline-test-pw"
NORMALIZER_PASSWORD = "normalizer-test-pw"
CORRELATOR_PASSWORD = "correlator-test-pw"
GROUPER_PASSWORD = "grouper-test-pw"


@pytest.fixture(scope="session")
def database():
    """A scratch database with every migration applied; yields
    (admin_url, pipeline_role_url, normalizer_role_url, correlator_role_url, grouper_role_url)."""
    name = f"pipeline_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    admin_url = make_conninfo(ADMIN_URL, dbname=name)
    with psycopg.connect(admin_url, autocommit=True) as conn:
        for file in sorted(MIGRATIONS.glob("*.sql")):
            conn.execute(file.read_text())  # type: ignore[arg-type]
        conn.execute(sql.SQL("ALTER ROLE sentra_pipeline LOGIN PASSWORD {}").format(sql.Literal(PIPELINE_PASSWORD)))
        conn.execute(sql.SQL("ALTER ROLE sentra_normalizer LOGIN PASSWORD {}").format(sql.Literal(NORMALIZER_PASSWORD)))
        conn.execute(sql.SQL("ALTER ROLE sentra_correlator LOGIN PASSWORD {}").format(sql.Literal(CORRELATOR_PASSWORD)))
        conn.execute(sql.SQL("ALTER ROLE sentra_grouper LOGIN PASSWORD {}").format(sql.Literal(GROUPER_PASSWORD)))
    yield (
        admin_url,
        make_conninfo(admin_url, user="sentra_pipeline", password=PIPELINE_PASSWORD),
        make_conninfo(admin_url, user="sentra_normalizer", password=NORMALIZER_PASSWORD),
        make_conninfo(admin_url, user="sentra_correlator", password=CORRELATOR_PASSWORD),
        make_conninfo(admin_url, user="sentra_grouper", password=GROUPER_PASSWORD),
    )
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest.fixture(scope="session")
def bucket():
    s3 = make_client(S3_ENDPOINT, *S3_KEYS)
    name = f"pipeline-test-{uuid.uuid4().hex[:8]}"
    s3.create_bucket(Bucket=name)
    yield s3, name
    for obj in s3.list_objects_v2(Bucket=name).get("Contents", []):
        s3.delete_object(Bucket=name, Key=obj["Key"])
    s3.delete_bucket(Bucket=name)


@pytest.fixture
def admin(database):
    """Admin connection to the scratch DB, with one org, user and project to hang imports on."""
    with psycopg.connect(database[0], autocommit=True) as conn:
        conn.execute(
            "TRUNCATE sbom_outbox, sbom_imports, projects, memberships, audit_events, organizations, users CASCADE"
        )
        user = conn.execute("INSERT INTO users (issuer, subject) VALUES ('i', 's') RETURNING id").fetchone()
        assert user
        org = conn.execute(
            "INSERT INTO organizations (name, slug, created_by) VALUES ('Acme', 'acme', %s) RETURNING id", (user[0],)
        ).fetchone()
        assert org
        project = conn.execute(
            "INSERT INTO projects (org_id, name, slug, created_by) VALUES (%s, 'App', 'app', %s) RETURNING id",
            (org[0], user[0]),
        ).fetchone()
        assert project
        conn.info_ids = (user[0], org[0], project[0])  # type: ignore[attr-defined]
        yield conn


@pytest.fixture
def clean_bucket(bucket):
    s3, name = bucket
    for obj in s3.list_objects_v2(Bucket=name).get("Contents", []):
        s3.delete_object(Bucket=name, Key=obj["Key"])
    return s3, name


class FlakyS3:
    """The real S3 client, except the first `fail_reads` get_object calls raise (a storage outage)."""

    def __init__(self, s3: Any):
        self._s3 = s3
        self.fail_reads = 0
        self.reads = 0

    def get_object(self, **kwargs: Any) -> Any:
        self.reads += 1
        if self.fail_reads:
            self.fail_reads -= 1
            raise ConnectionError("storage unavailable")
        return self._s3.get_object(**kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._s3, name)


class Harness:
    def __init__(self, database, bucket, admin, max_bytes: int = 10 * 1024 * 1024):
        self.s3, self.bucket = bucket
        self.pipeline_url = database[1]
        self.admin = admin
        self.user_id, self.org_id, self.project_id = admin.info_ids
        self.flaky = FlakyS3(self.s3)
        self.sleeps: list[float] = []
        self.published: list[dict[str, Any]] = []
        self.publish_fails = 0
        self.limits = Limits(max_bytes=max_bytes, max_attempts=3, backoff_base=0.01, backoff_cap=0.02)

    def _publish(self, event: dict[str, Any]) -> None:
        if self.publish_fails:
            self.publish_fails -= 1
            raise ConnectionError("broker unavailable")
        self.published.append(event)

    def deps(self) -> Deps:
        """A fresh Deps (and database connection), as a separate worker would have."""
        return Deps(
            imports=Imports(self.pipeline_url),
            s3=self.flaky,
            bucket=self.bucket,
            limits=self.limits,
            sleep=self.sleeps.append,
            publish=self._publish,
        )

    def add_import(
        self, body: bytes | None, *, status: str = "uploaded", reason: str | None = None, filename: str = "sbom.json"
    ) -> str:
        """Insert an import as the API would, and upload `body` at its object key (None: no object)."""
        import_id = str(uuid.uuid4())
        key = f"sbom/{self.org_id}/{self.project_id}/{import_id}.json"
        self.admin.execute(
            "INSERT INTO sbom_imports "
            "(id, org_id, project_id, created_by, filename, status, reason_code, object_key, expires_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now() + interval '15 minutes')",
            (import_id, self.org_id, self.project_id, self.user_id, filename, status, reason, key),
        )
        if body is not None:
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=body)
        return import_id

    def row(self, import_id: str) -> dict[str, Any]:
        cur = self.admin.execute(
            "SELECT status, reason_code, size_bytes, sha256, filename, object_key FROM sbom_imports WHERE id = %s",
            (import_id,),
        )
        names = [d.name for d in cur.description or []]
        found = cur.fetchone()
        assert found
        return dict(zip(names, found, strict=True))

    def event(self, import_id: str, **over: Any) -> dict[str, Any]:
        row = self.row(import_id)
        event = {
            "eventId": str(uuid.uuid4()),
            "type": "sbom.uploaded",
            "version": 1,
            "timestamp": "2026-10-08T09:00:00Z",
            "correlationId": "it-corr-1",
            "importId": import_id,
            "orgId": str(self.org_id),
            "projectId": str(self.project_id),
            "artifact": {"bucket": self.bucket, "key": row["object_key"], "sizeBytes": 1000},
        }
        return {**event, **over}


@pytest.fixture
def harness(database, clean_bucket, admin) -> Harness:
    return Harness(database, clean_bucket, admin)


@pytest.fixture
def valid_sbom() -> bytes:
    return (FIXTURES / "cyclonedx-1.6.json").read_bytes()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


Factory = Callable[..., Harness]


@pytest.fixture
def env(database, clean_bucket):
    """Normalizer harness over a clean set of vulnerability tables."""
    e = Env(database, clean_bucket)
    e.q(
        "TRUNCATE group_conflicts, vulnerability_group_members, vulnerability_groups, kev_entries, findings, "
        "vulnerability_ranges, vulnerability_affected, vulnerabilities, normalization_runs, "
        "normalization_failures"
    )
    yield e
    for store in e.stores:
        store.close()


@pytest.fixture
def world(database, admin):
    w = World(database, admin)
    yield w
    w.close()
