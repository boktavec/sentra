"""Run tracking: migration 017 on existing data, the claim path for scheduler-recorded runs, and the CLI."""

import uuid

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

from conftest import ADMIN_URL, MIGRATIONS, make_request
from crawler import runs_cli
from crawler.ingest import handle
from crawler.runs import Runs
from fake_osv import Response, make_zip

NPM = "/npm/all.zip"
MIGRATION = "017_ingestion_job_tracking.sql"


@pytest.fixture
def pre_017_database():
    """A scratch database migrated up to (not including) 017, as production is before the rollout."""
    name = f"crawler_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as server:
        server.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(ADMIN_URL, dbname=name)
    with psycopg.connect(url, autocommit=True) as conn:
        for file in sorted(MIGRATIONS.glob("*.sql")):
            if file.name < MIGRATION:
                conn.execute(file.read_text())  # type: ignore[arg-type]
        yield conn
    with psycopg.connect(ADMIN_URL, autocommit=True) as server:
        server.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


def test_migration_017_keeps_existing_runs_and_backfills_their_times(pre_017_database):
    conn = pre_017_database
    sha = "a" * 64
    for run_id, status in (("published", "published"), ("failed", "failed"), ("fetching", "fetching")):
        conn.execute(
            "INSERT INTO ingestion_runs (run_id, source, ecosystem, status, correlation_id, artifact_key, sha256, "
            "created_at, updated_at) VALUES (gen_random_uuid(), %s, 'npm', %s, 'c', %s, %s, "
            "now() - interval '2 hours', now() - interval '1 hour')",
            (run_id, status, "raw/x" if status == "published" else None, sha if status == "published" else None),
        )

    conn.execute((MIGRATIONS / MIGRATION).read_text())  # type: ignore[arg-type]

    rows = conn.execute(
        "SELECT status, trigger, started_at = created_at, completed_at = updated_at, completed_at IS NULL, "
        "failure_kind FROM ingestion_runs ORDER BY status"
    ).fetchall()
    assert rows == [
        ("failed", "manual", True, True, False, None),
        ("fetching", "manual", True, None, True, None),
        ("published", "manual", True, True, False, None),
    ]
    conn.execute(
        "INSERT INTO ingestion_runs (run_id, source, ecosystem, status, correlation_id) "
        "VALUES (gen_random_uuid(), 'osv', 'npm', 'requested', 'c')"
    )
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("UPDATE ingestion_runs SET failure_kind = 'transient' WHERE status = 'requested'")


def test_the_claim_moves_a_requested_run_to_fetching_and_records_when_it_started(harness, admin):
    run_id = str(uuid.uuid4())
    admin.execute(
        "INSERT INTO ingestion_runs (run_id, source, ecosystem, status, correlation_id, trigger) "
        "VALUES (%s, 'osv', 'npm', 'requested', 'schedule-1', 'schedule')",
        (run_id,),
    )
    runs = Runs.connect(harness.crawler_url)

    claimed = runs.claim(run_id, "osv", "npm", "ignored-by-existing-rows", 60)

    assert claimed is not None and claimed.status == "fetching" and claimed.correlation_id == "schedule-1"
    assert admin.execute(
        "SELECT status, trigger, started_at IS NOT NULL, completed_at FROM ingestion_runs"
    ).fetchone() == ("fetching", "schedule", True, None)
    assert runs.claim(run_id, "osv", "npm", "c", 60) is None  # leased: a concurrent redelivery backs off


def test_a_manual_request_creates_its_own_row_as_before(harness, admin):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    assert handle(make_request(), harness.deps()) == "published"
    assert admin.execute(
        "SELECT trigger, status, started_at IS NOT NULL, completed_at IS NOT NULL FROM ingestion_runs"
    ).fetchone() == (
        "manual",
        "published",
        True,
        True,
    )


def test_a_run_expired_by_the_scheduler_cannot_be_claimed(harness, admin):
    run_id = str(uuid.uuid4())
    admin.execute(
        "INSERT INTO ingestion_runs (run_id, source, ecosystem, status, correlation_id, failure_kind, completed_at) "
        "VALUES (%s, 'osv', 'npm', 'failed', 'c', 'expired', now())",
        (run_id,),
    )
    assert Runs.connect(harness.crawler_url).claim(run_id, "osv", "npm", "c", 60) is None


def test_the_runs_command_lists_recent_runs_per_source_and_ecosystem(admin, database, monkeypatch, capsys):
    for source, ecosystem, status, kind in (
        ("osv", "npm", "published", None),
        ("osv", "npm", "failed", "transient"),
        ("osv", "PyPI", "unchanged", None),
        ("cisa-kev", "none", "requested", None),
    ):
        admin.execute(
            "INSERT INTO ingestion_runs (run_id, source, ecosystem, status, correlation_id, failure_kind, "
            "artifact_key, sha256, completed_at) VALUES (gen_random_uuid(), %s, %s, %s, 'c', %s, %s, %s, now())",
            (
                source,
                ecosystem,
                status,
                kind,
                "raw/x" if status == "published" else None,
                "a" * 64 if status == "published" else None,
            ),
        )
    monkeypatch.setenv("CRAWLER_DATABASE_URL", database[1])

    assert runs_cli.main(["--limit", "1"]) == 0
    out = capsys.readouterr().out
    lines = out.splitlines()[1:]
    assert sorted(line.split()[:2] for line in lines) == [["cisa-kev", "none"], ["osv", "PyPI"], ["osv", "npm"]]

    assert runs_cli.main(["--status", "failed"]) == 0
    (line,) = capsys.readouterr().out.splitlines()[1:]
    assert line.split()[:2] == ["osv", "npm"] and "transient" in line


def test_the_runs_command_says_so_when_there_are_no_runs(admin, database, monkeypatch, capsys):
    monkeypatch.setenv("CRAWLER_DATABASE_URL", database[1])
    assert runs_cli.main([]) == 0
    assert "no runs" in capsys.readouterr().out
