"""The worker's SQL against real Postgres, as the real `sentra_intelligence` grants allow.

Needs `task stack:up` and `task stack:bootstrap` (DATABASE_URL). Each run migrates a scratch database, so a
live worker on the dev database cannot claim these rows. Run with `task intelligence:test:integration`.
"""

import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import LiteralString, cast
from urllib.parse import quote, urlsplit, urlunsplit

import psycopg
import pytest
from psycopg import sql

from intelligence.store import Run, Store

MIGRATIONS = Path(__file__).resolve().parents[4] / "apps" / "api" / "migrations"
LEASE, DEADLINE, MAX_ATTEMPTS = 180, 600, 3


def with_database(url: str, name: str, role: str | None = None) -> str:
    parts = urlsplit(url)
    query = f"options={quote(f'-c role={role}')}" if role else ""
    return urlunsplit(parts._replace(path=f"/{name}", query=query))


@dataclass(frozen=True)
class Scratch:
    admin: psycopg.Connection
    worker_url: str


@pytest.fixture(scope="module")
def scratch() -> Iterator[Scratch]:
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.fail("DATABASE_URL is required (see `task intelligence:test:integration`)")
    name = f"sentra_it_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(url, autocommit=True) as root:
        root.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    conn = psycopg.connect(with_database(url, name), autocommit=True)
    try:
        for file in sorted(MIGRATIONS.glob("*.sql")):
            conn.execute(sql.SQL(cast(LiteralString, file.read_text())))
        yield Scratch(conn, with_database(url, name, "sentra_intelligence"))
    finally:
        conn.close()
        with psycopg.connect(url, autocommit=True) as root:
            root.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest.fixture
def admin(scratch: Scratch) -> psycopg.Connection:
    scratch.admin.execute("DELETE FROM investigations")
    return scratch.admin


@pytest.fixture
def store(scratch: Scratch, admin: psycopg.Connection) -> Iterator[Store]:
    s = Store(scratch.worker_url)
    try:
        yield s
    finally:
        s.close()


def seed_run(admin: psycopg.Connection, prompt_version: int = 1) -> str:
    """A queued investigation due long ago, with every row it needs. Returns its id."""
    tag = uuid.uuid4().hex[:8]
    user = admin.execute("INSERT INTO users (issuer, subject) VALUES ('http://t', %s) RETURNING id", (tag,)).fetchone()
    org = admin.execute(
        "INSERT INTO organizations (name, slug, created_by) VALUES (%s, %s, %s) RETURNING id",
        (tag, f"it-{tag}", user[0]),  # type: ignore[index]
    ).fetchone()
    project = admin.execute(
        "INSERT INTO projects (org_id, name, slug, created_by) VALUES (%s, 'app', 'app', %s) RETURNING id",
        (org[0], user[0]),  # type: ignore[index]
    ).fetchone()
    imported = admin.execute(
        """INSERT INTO sbom_imports (org_id, project_id, created_by, filename, object_key, expires_at)
           VALUES (%s, %s, %s, 'b.json', %s, now() + interval '1 day') RETURNING id""",
        (org[0], project[0], user[0], tag),  # type: ignore[index]
    ).fetchone()
    vuln = admin.execute(
        """INSERT INTO vulnerabilities (source, source_id, modified_at, source_artifact_sha256, source_entry,
             schema_version, adapter_version) VALUES ('osv', %s, now(), %s, 'e', 1, 1) RETURNING id""",
        (tag, "a" * 64),
    ).fetchone()
    finding = admin.execute(
        """INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope, import_id,
             match_quality, matcher_version, evidence)
           VALUES (%s, %s, %s, %s, '1', 'PyPI', 'required', %s, 'confirmed', 1, '{}') RETURNING id""",
        (org[0], project[0], vuln[0], f"pkg:pypi/{tag}@1", imported[0]),  # type: ignore[index]
    ).fetchone()
    run = admin.execute(
        """INSERT INTO investigations (org_id, project_id, finding_id, created_by, context_snapshot, model_id,
             prompt_version, next_attempt_at) VALUES (%s, %s, %s, %s, '{}', 'm', %s, '2000-01-01') RETURNING id""",
        (org[0], project[0], finding[0], user[0], prompt_version),  # type: ignore[index]
    ).fetchone()
    return str(run[0])  # type: ignore[index]


def claim(store: Store) -> Run:
    run = store.claim(LEASE, MAX_ATTEMPTS, DEADLINE)
    assert run is not None
    return run


def seconds_left(admin: psycopg.Connection, run: Run, column: str) -> float:
    query = sql.SQL("SELECT extract(epoch FROM {} - now()) FROM investigations WHERE id = %s")
    row = admin.execute(query.format(sql.Identifier(column)), (run.id,)).fetchone()
    return float(row[0])  # type: ignore[index]


def test_claim_pins_the_prompt_version_and_sets_the_attempt_deadline(admin, store):
    old, new = seed_run(admin, 1), seed_run(admin, 2)
    first, second = claim(store), claim(store)
    assert {first.id: first.prompt_version, second.id: second.prompt_version} == {old: 1, new: 2}
    assert first.attempts == 1
    assert 590 < seconds_left(admin, first, "attempt_deadline_at") <= 600
    assert 170 < seconds_left(admin, first, "lease_expires_at") <= 180


def test_renewal_extends_the_lease_but_never_past_the_attempt_deadline(admin, store):
    seed_run(admin)
    run = claim(store)
    admin.execute(
        "UPDATE investigations SET attempt_deadline_at = now() + interval '60 seconds' WHERE id = %s", (run.id,)
    )
    assert store.renew_lease(run, LEASE) is True
    assert 50 < seconds_left(admin, run, "lease_expires_at") <= 60


def test_renewal_fails_when_the_run_is_no_longer_ours(admin, store):
    seed_run(admin)
    run = claim(store)
    other = Run(run.id, run.org_id, run.model_id, run.context, run.attempts, str(uuid.uuid4()), run.prompt_version)
    assert store.renew_lease(other, LEASE) is False  # another lease owner
    admin.execute("UPDATE investigations SET lease_expires_at = now() - interval '1 second' WHERE id = %s", (run.id,))
    assert store.renew_lease(run, LEASE) is False  # expired, so it may already belong to another worker
    admin.execute("UPDATE investigations SET lease_expires_at = now() + interval '1 minute' WHERE id = %s", (run.id,))
    assert store.complete(run, "draft") is True
    assert store.renew_lease(run, LEASE) is False  # finished


@pytest.mark.parametrize("code", ["tool_unavailable", "tool_unauthorized", "deadline_exceeded"])
def test_the_new_failure_codes_are_stored_and_retry_follows_the_policy(admin, store, code):
    seed_run(admin)
    run = claim(store)
    assert store.fail(run, code, True, MAX_ATTEMPTS) == "queued"
    admin.execute("UPDATE investigations SET next_attempt_at = '2000-01-01' WHERE id = %s", (run.id,))
    run = claim(store)
    assert store.fail(run, code, False, MAX_ATTEMPTS) == "failed"
    row = admin.execute(
        "SELECT status, failure_code, lease_owner FROM investigations WHERE id = %s", (run.id,)
    ).fetchone()
    assert row == ("failed", code, None)


def test_the_worker_role_reaches_only_investigation_lifecycle_rows(admin, store):
    seed_run(admin)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        store.conn.execute("SELECT 1 FROM findings LIMIT 1")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        store.conn.execute("SELECT 1 FROM investigation_tool_calls LIMIT 1")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        store.conn.execute("SELECT 1 FROM investigation_results LIMIT 1")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        store.conn.execute("UPDATE investigations SET org_id = org_id")


def test_rollback_runbook_fails_unfinished_v2_runs_and_leaves_everything_else(admin):
    v1, v2_queued, v2_running = seed_run(admin, 1), seed_run(admin, 2), seed_run(admin, 2)
    admin.execute(
        """UPDATE investigations SET status = 'running', attempts = 1, lease_owner = gen_random_uuid(),
             lease_expires_at = now() + interval '1 minute' WHERE id = %s""",
        (v2_running,),
    )
    runbook = Path(__file__).resolve().parents[2] / "runbooks" / "rollback-prompt-v2.sql"
    admin.execute(sql.SQL(cast(LiteralString, runbook.read_text())))
    rows = admin.execute("SELECT id::text, status, failure_code FROM investigations").fetchall()
    assert {r[0]: (r[1], r[2]) for r in rows} == {
        v1: ("queued", None),
        v2_queued: ("failed", "processing_error"),
        v2_running: ("failed", "processing_error"),
    }


def test_rollback_runbook_for_v3_fails_unfinished_v3_runs_and_leaves_everything_else(admin):
    v2, v3_queued, v3_running = seed_run(admin, 2), seed_run(admin, 3), seed_run(admin, 3)
    admin.execute(
        """UPDATE investigations SET status = 'running', attempts = 1, lease_owner = gen_random_uuid(),
             lease_expires_at = now() + interval '1 minute' WHERE id = %s""",
        (v3_running,),
    )
    runbook = Path(__file__).resolve().parents[2] / "runbooks" / "rollback-prompt-v3.sql"
    admin.execute(sql.SQL(cast(LiteralString, runbook.read_text())))
    rows = admin.execute("SELECT id::text, status, failure_code FROM investigations").fetchall()
    assert {r[0]: (r[1], r[2]) for r in rows} == {
        v2: ("queued", None),
        v3_queued: ("failed", "processing_error"),
        v3_running: ("failed", "processing_error"),
    }


def complete_without_draft(admin: psycopg.Connection, run_id: str) -> None:
    admin.execute("UPDATE investigations SET status = 'completed', completed_at = now() WHERE id = %s", (run_id,))


def test_only_a_v3_run_may_complete_without_a_draft(admin):
    v2, v3 = seed_run(admin, 2), seed_run(admin, 3)
    with pytest.raises(psycopg.errors.CheckViolation):
        complete_without_draft(admin, v2)
    complete_without_draft(admin, v3)  # its result lives in investigation_results
    queued = seed_run(admin, 3)
    with pytest.raises(psycopg.errors.CheckViolation):
        admin.execute(
            "UPDATE investigations SET draft = 'text' WHERE id = %s", (queued,)
        )  # a draft only when completed
