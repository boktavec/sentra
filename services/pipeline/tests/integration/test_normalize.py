"""Normalizer against real Postgres and an S3 API, using real OSV records as fixtures."""

import copy
import threading
from typing import Any

import psycopg
import pytest
from normalize_support import ECOSYSTEM, GOOD, good_entries, make_zip, record  # noqa: F401

from pipeline.normalize import process
from pipeline.normalize.adapters import osv
from pipeline.normalize.backfill_cvss import backfill
from pipeline.normalize.process import Busy, handle
from pipeline.normalize.store import LeaseLost


def test_first_run_stores_records_with_provenance_and_publishes_once(env):
    _, sha = env.upload(good_entries())
    assert handle(env.event(sha), env.deps()) == "published"

    rows = env.q(
        "SELECT source, source_id, source_artifact_sha256, source_entry, schema_version, adapter_version "
        "FROM vulnerabilities ORDER BY source_id"
    )
    assert len(rows) == len(GOOD)
    assert {r[1] for r in rows} == {record(n)["id"] for n in GOOD}
    assert all(r[0] == "osv" and r[2] == sha and r[3] == f"{r[1]}.json" for r in rows)
    assert all(r[4] == 1 and r[5] == osv.ADAPTER_VERSION for r in rows)
    assert env.run(sha) == {
        "status": "published",
        "upserted": len(GOOD),
        "unchanged": 0,
        "quarantined": 0,
        "error": None,
    }
    (event,) = env.published
    assert event["type"] == "vulnerabilities.normalized"
    assert event["counts"] == {"upserted": len(GOOD), "unchanged": 0, "quarantined": 0}
    assert event["artifactSha256"] == sha


def test_affected_ranges_and_versions_are_stored(env):
    _, sha = env.upload({"a.json": record("semver_fixed"), "b.json": record("versions_only")})
    handle(env.event(sha), env.deps())
    raw = record("semver_fixed")
    (vid,) = env.q("SELECT id FROM vulnerabilities WHERE source_id = %s", raw["id"])[0]
    events = env.q(
        "SELECT r.range_type, r.event_type, r.event_version FROM vulnerability_ranges r "
        "JOIN vulnerability_affected a ON a.id = r.affected_id WHERE a.vulnerability_id = %s "
        "ORDER BY a.package_name, r.range_index, r.event_index",
        vid,
    )
    assert events and {e[0] for e in events} <= {"SEMVER", "ECOSYSTEM"}
    versions = env.q(
        "SELECT cardinality(a.versions) FROM vulnerability_affected a "
        "JOIN vulnerabilities v ON v.id = a.vulnerability_id WHERE v.source_id = %s",
        record("versions_only")["id"],
    )
    assert any(v[0] > 0 for v in versions)


def test_cvss_score_is_written_and_existing_rows_can_be_backfilled(env):
    raw = record("versions_only")
    _, sha = env.upload({"score.json": raw})
    assert handle(env.event(sha), env.deps()) == "published"
    original = env.q(
        "SELECT cvss_score, cvss_version, cvss_calculated_at FROM vulnerabilities WHERE source_id = %s", raw["id"]
    )
    assert original[0][0] is not None and original[0][1] == "3.1" and original[0][2] is not None

    env.q(
        "UPDATE vulnerabilities SET cvss_score = NULL, cvss_version = NULL, "
        "cvss_calculated_at = NULL WHERE source_id = %s",
        raw["id"],
    )
    with psycopg.connect(env.normalizer_url, autocommit=True) as conn:
        assert backfill(conn, batch_size=1) == 1
        assert backfill(conn, batch_size=1) == 0
    restored = env.q(
        "SELECT cvss_score, cvss_version, cvss_calculated_at FROM vulnerabilities WHERE source_id = %s", raw["id"]
    )
    assert restored[0][0:2] == original[0][0:2]
    assert restored[0][2] is not None


def test_withdrawn_is_kept_and_git_ranges_are_not(env):
    _, sha = env.upload(good_entries())
    handle(env.event(sha), env.deps())
    (withdrawn,) = env.q("SELECT withdrawn_at FROM vulnerabilities WHERE source_id = %s", record("withdrawn")["id"])
    assert withdrawn[0] is not None
    assert env.q("SELECT 1 FROM vulnerability_ranges WHERE range_type NOT IN ('SEMVER', 'ECOSYSTEM')") == []


def test_redelivery_changes_nothing_and_sends_no_second_event(env):
    _, sha = env.upload(good_entries())
    event = env.event(sha)
    handle(event, env.deps())
    before = env.q("SELECT source_id, updated_at FROM vulnerabilities ORDER BY source_id")
    assert handle(event, env.deps()) == "skipped_duplicate"
    assert env.q("SELECT source_id, updated_at FROM vulnerabilities ORDER BY source_id") == before
    assert len(env.published) == 1


def test_a_new_artifact_with_the_same_records_rewrites_nothing(env):
    entries = good_entries()
    _, first = env.upload(entries)
    handle(env.event(first), env.deps())
    before = env.q("SELECT source_id, updated_at, source_artifact_sha256 FROM vulnerabilities ORDER BY source_id")
    entries["extra.txt"] = b"changes the zip bytes, not the records"  # type: ignore[assignment]
    _, second = env.upload(entries)
    assert second != first
    assert handle(env.event(second), env.deps()) == "published"
    assert (
        env.q("SELECT source_id, updated_at, source_artifact_sha256 FROM vulnerabilities ORDER BY source_id") == before
    )
    assert env.run(second)["unchanged"] == len(GOOD) and env.run(second)["upserted"] == 0


def test_newer_modified_updates_and_older_never_overwrites(env):
    base = record("ecosystem_pysec")
    newer = {**copy.deepcopy(base), "modified": "2030-01-01T00:00:00Z", "summary": "newer"}
    older = {**copy.deepcopy(base), "modified": "2001-01-01T00:00:00Z", "summary": "older"}
    _, a = env.upload({"x.json": base})
    _, b = env.upload({"x.json": newer})
    _, c = env.upload({"x.json": older})
    for sha in (a, b, c):
        handle(env.event(sha), env.deps())
    ((summary, entry_sha),) = env.q("SELECT summary, source_artifact_sha256 FROM vulnerabilities")
    assert summary == "newer" and entry_sha == b
    assert env.run(c)["unchanged"] == 1


def test_a_newer_adapter_version_rewrites_unchanged_advisories(env, monkeypatch):
    _, sha = env.upload({"x.json": record("ecosystem_pysec")})
    handle(env.event(sha), env.deps())
    monkeypatch.setitem(process.ADAPTERS, "osv", (lambda raw: {**osv.normalize(raw), "summary": "fixed by v2"}, 2))
    assert handle(env.event(sha), env.deps()) == "published"
    assert env.q("SELECT summary, adapter_version FROM vulnerabilities") == [("fixed by v2", 2)]
    assert len(env.published) == 2 and env.published[1]["adapterVersion"] == 2
    # Reprocessing again at v2 is a no-op.
    assert handle(env.event(sha), env.deps()) == "skipped_duplicate"


def test_invalid_records_are_quarantined_with_their_artifact_and_entry(env):
    entries = good_entries()
    entries["broken.json"] = b"{not json"
    missing_id = record("malware")
    del missing_id["id"]
    entries["no-id.json"] = missing_id
    _, sha = env.upload(entries)
    assert handle(env.event(sha), env.deps(min_records_for_rate=1000)) == "published"

    assert env.q("SELECT count(*) FROM vulnerabilities") == [(len(GOOD),)]
    failures = env.q(
        "SELECT artifact_sha256, entry_name, adapter_version, error FROM normalization_failures ORDER BY entry_name"
    )
    assert [(f[0], f[1], f[2]) for f in failures] == [(sha, "broken.json", 1), (sha, "no-id.json", 1)]
    assert "not valid JSON" in failures[0][3]
    assert env.run(sha)["quarantined"] == 2
    assert env.published[0]["counts"]["quarantined"] == 2


def test_reprocessing_does_not_duplicate_quarantine_rows(env):
    entries = good_entries()
    entries["broken.json"] = b"{not json"
    _, sha = env.upload(entries)
    handle(env.event(sha), env.deps())
    env.q("UPDATE normalization_runs SET status = 'failed'")  # an operator-visible failed run, retaken below
    handle(env.event(sha), env.deps())
    assert env.q("SELECT count(*) FROM normalization_failures") == [(1,)]


def test_too_many_failures_fail_the_run_without_an_event(env):
    entries: dict[str, dict[str, Any] | bytes] = {f"bad{i}.json": b"{nope" for i in range(8)}
    entries.update({"ok1.json": record("ecosystem_pysec"), "ok2.json": record("malware")})
    _, sha = env.upload(entries)
    assert handle(env.event(sha), env.deps(min_records_for_rate=5, max_failure_rate=0.2)) == "failed"
    run = env.run(sha)
    assert run["status"] == "failed" and "records failed" in run["error"]
    assert env.published == []
    assert env.q("SELECT count(*) FROM normalization_failures")[0][0] >= 1


@pytest.mark.parametrize(
    ("limits", "reason"),
    [
        ({"max_entries": 2}, "entries"),
        ({"max_entry_bytes": 200}, "declares"),
        ({"max_total_bytes": 500}, "declared size"),
    ],
)
def test_zip_limits_fail_the_run_before_anything_is_written(env, limits, reason):
    _, sha = env.upload(good_entries())
    assert handle(env.event(sha), env.deps(**limits)) == "failed"
    assert reason in env.run(sha)["error"]
    assert env.q("SELECT count(*) FROM vulnerabilities") == [(0,)]
    assert env.published == []


def test_an_artifact_that_does_not_match_its_sha256_fails(env):
    data = make_zip(good_entries())
    wrong = "0" * 64
    env.s3.put_object(Bucket=env.bucket, Key=f"raw/osv/{ECOSYSTEM}/{wrong}.zip", Body=data)
    assert handle(env.event(wrong), env.deps()) == "failed"
    assert "sha256" in env.run(wrong)["error"]
    assert env.q("SELECT count(*) FROM vulnerabilities") == [(0,)]


def test_a_non_zip_artifact_fails_and_does_not_retry_forever(env):
    _, sha = env.upload(b"PK this is not a zip")
    assert handle(env.event(sha), env.deps()) == "failed"
    assert env.run(sha)["status"] == "failed"


def test_events_are_dropped_not_processed_when_invalid_untrusted_or_for_another_source(env):
    _, sha = env.upload(good_entries())
    deps = env.deps()
    assert handle({"type": "artifact.ingested"}, deps) == "dropped_invalid"
    elsewhere = env.event(sha)
    elsewhere["artifact"]["key"] = "sbom/someone-elses/file.zip"
    assert handle(elsewhere, deps) == "dropped_untrusted"
    assert handle(env.event(sha, source="ghsa"), deps) == "skipped_source"
    assert env.q("SELECT count(*) FROM normalization_runs") == [(0,)]


def test_a_crash_between_commit_and_publish_is_recovered_by_redelivery(env):
    _, sha = env.upload(good_entries())
    event = env.event(sha)
    env.publish_fails = 1
    with pytest.raises(ConnectionError):
        handle(event, env.deps())
    assert env.run(sha)["status"] == "completed" and env.published == []
    assert handle(event, env.deps()) == "published"
    assert env.run(sha)["status"] == "published" and len(env.published) == 1


def test_a_storage_outage_is_retried_by_redelivery_not_recorded_as_a_bad_artifact(env):
    _, sha = env.upload(good_entries())
    event = env.event(sha)
    env.flaky.fail = 1
    with pytest.raises(ConnectionError):
        handle(event, env.deps())
    assert env.run(sha)["status"] == "failed"  # released, so the redelivery can retake it at once
    assert handle(event, env.deps()) == "published"
    assert env.q("SELECT count(*) FROM vulnerabilities") == [(len(GOOD),)]


def test_a_live_lease_blocks_other_workers_and_an_expired_one_is_retaken(env):
    _, sha = env.upload(good_entries())
    event = env.event(sha)
    claim = env.deps().store.claim(
        sha256=sha, source="osv", ecosystem=ECOSYSTEM, adapter_version=1, correlation_id="c", lease_seconds=900
    )
    assert claim.state == "claimed"
    with pytest.raises(Busy):
        handle(event, env.deps())
    env.q("UPDATE normalization_runs SET claimed_until = now() - interval '1 minute'")
    assert handle(event, env.deps()) == "published"


def test_a_worker_that_lost_its_lease_writes_nothing(env):
    _, sha = env.upload(good_entries())
    store = env.deps().store
    claim = store.claim(
        sha256=sha, source="osv", ecosystem=ECOSYSTEM, adapter_version=1, correlation_id="c", lease_seconds=900
    )
    env.q("UPDATE normalization_runs SET status = 'failed'")  # someone else retook and finished it
    doc = osv.normalize(record("ecosystem_pysec"))
    with pytest.raises(LeaseLost):
        store.commit_batch(
            claim.run_id,
            sha256=sha,
            adapter_version=1,
            schema_version=1,
            ok=[("x.json", doc)],
            failed=[],
            lease_seconds=900,
        )
    assert env.q("SELECT count(*) FROM vulnerabilities") == [(0,)]


def test_concurrent_deliveries_of_one_artifact_publish_once(env):
    _, sha = env.upload(good_entries())
    event = env.event(sha)
    outcomes: list[str] = []

    def go() -> None:
        try:
            outcomes.append(handle(event, env.deps()))
        except Busy:
            outcomes.append("busy")

    threads = [threading.Thread(target=go) for _ in range(4)]
    [t.start() for t in threads]
    [t.join(60) for t in threads]
    assert outcomes.count("published") == 1
    assert set(outcomes) <= {"published", "busy", "skipped_duplicate"}
    assert len(env.published) == 1
    assert env.q("SELECT count(*) FROM vulnerabilities") == [(len(GOOD),)]


def test_the_normalizer_role_cannot_touch_tenant_data(env):
    store = env.deps().store
    for table in ("sbom_imports", "sbom_dependencies", "projects", "ingestion_runs"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            store.conn.execute(f"SELECT 1 FROM {table}")  # type: ignore[arg-type]  # noqa: S608 - fixed names
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        store.conn.execute("DELETE FROM vulnerabilities")
