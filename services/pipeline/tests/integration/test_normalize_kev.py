"""KEV normalization against real Postgres and S3, using a slice of the real CISA catalog."""

import copy
import hashlib
import json
from pathlib import Path
from typing import Any

import psycopg
import pytest
from normalize_support import ECOSYSTEM  # noqa: F401

from pipeline.normalize.process import handle

CATALOG = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "kev" / "catalog.json").read_text())
KEV_ID = "CVE-2021-44228"


def snapshot(*, drop: tuple[str, ...] = (), version: str = "2026.10.08", entries: list[Any] | None = None) -> dict:
    doc = copy.deepcopy(CATALOG)
    doc["vulnerabilities"] = (
        entries if entries is not None else [v for v in doc["vulnerabilities"] if v["cveID"] not in drop]
    )
    doc["count"] = len(doc["vulnerabilities"])
    doc["catalogVersion"] = version
    return doc


def many(n: int) -> list[dict]:
    """n distinct entries shaped like real ones."""
    base = CATALOG["vulnerabilities"][0]
    return [{**base, "cveID": f"CVE-2020-{10000 + i}"} for i in range(n)]


def upload(env, doc: dict | bytes) -> str:
    data = doc if isinstance(doc, bytes) else json.dumps(doc).encode()
    sha = hashlib.sha256(data).hexdigest()
    env.s3.put_object(Bucket=env.bucket, Key=f"raw/cisa-kev/none/{sha}.json", Body=data)
    return sha


def event(env, sha: str, **over: Any) -> dict:
    ev = env.event(sha, source="cisa-kev", ecosystem="none")
    ev["artifact"]["key"] = f"raw/cisa-kev/none/{sha}.json"
    return {**ev, **over}


def ingest(env, doc: dict | bytes, **limits: Any) -> tuple[str, str]:
    sha = upload(env, doc)
    return handle(event(env, sha), env.deps(**limits)), sha


def active(env) -> set[str]:
    return {r[0] for r in env.q("SELECT cve_id FROM kev_entries WHERE removed_at IS NULL")}


def test_first_run_stores_entries_with_provenance_and_linked_vulnerabilities(env):
    outcome, sha = ingest(env, snapshot())
    assert outcome == "published"

    assert active(env) == {v["cveID"] for v in CATALOG["vulnerabilities"]}
    (row,) = env.q(
        "SELECT name, date_added::text, due_date::text, known_ransomware_use, cwes, catalog_version, "
        "date_released IS NOT NULL, source_artifact_sha256, adapter_version FROM kev_entries "
        "WHERE cve_id = 'CVE-2015-5477'"
    )
    assert row[0] == "ISC BIND Data Processing Errors Vulnerability"  # the feed's leading space is trimmed
    assert row[1:] == ("2026-10-08", "2026-10-11", "Unknown", ["CWE-19"], "2026.10.08", True, sha, 1)

    (vuln,) = env.q(
        "SELECT source, summary, published_at IS NOT NULL, source_artifact_sha256 FROM vulnerabilities "
        "WHERE source_id = %s",
        KEV_ID,
    )
    assert vuln[0] == "cisa-kev" and vuln[2] and vuln[3] == sha
    assert env.q("SELECT count(*) FROM vulnerability_affected") == [(0,)]  # no vendor/product rows to match
    assert env.run(sha)["upserted"] == len(CATALOG["vulnerabilities"])
    (published,) = env.published
    assert published["source"] == "cisa-kev" and published["ecosystem"] == "none"


def test_new_snapshot_with_the_same_entries_changes_nothing(env):
    ingest(env, snapshot())
    before = env.q("SELECT cve_id, updated_at FROM kev_entries ORDER BY cve_id")
    vuln_before = env.q("SELECT source_id, updated_at FROM vulnerabilities ORDER BY source_id")

    outcome, sha = ingest(env, snapshot(version="2026.10.09"))  # a new artifact: the catalog was re-released

    assert outcome == "published"
    assert env.q("SELECT cve_id, updated_at FROM kev_entries ORDER BY cve_id") == before
    assert env.q("SELECT source_id, updated_at FROM vulnerabilities ORDER BY source_id") == vuln_before
    assert env.run(sha)["upserted"] == 0 and env.run(sha)["unchanged"] == len(before)


def test_processing_the_same_artifact_twice_is_a_duplicate(env):
    _, sha = ingest(env, snapshot())
    assert handle(event(env, sha), env.deps()) == "skipped_duplicate"
    assert len(env.published) == 1


def test_changed_entry_is_updated(env):
    ingest(env, snapshot())
    doc = snapshot(version="2026.10.09")
    doc["vulnerabilities"][0]["dueDate"] = "2026-12-01"
    ingest(env, doc)
    assert env.q("SELECT due_date::text, catalog_version FROM kev_entries WHERE cve_id = 'CVE-2015-5477'") == [
        ("2026-12-01", "2026.10.09")
    ]


def test_removed_cve_is_tombstoned_and_restored_when_it_returns(env):
    ingest(env, snapshot())
    ingest(env, snapshot(drop=(KEV_ID,), version="2026.10.09"))

    assert KEV_ID not in active(env)
    assert env.q("SELECT removed_at IS NOT NULL FROM kev_entries WHERE cve_id = %s", KEV_ID) == [(True,)]

    ingest(env, snapshot(version="2026.10.10"))
    assert KEV_ID in active(env)
    assert env.q("SELECT removed_at FROM kev_entries WHERE cve_id = %s", KEV_ID) == [(None,)]


def test_view_resolves_present_and_absent_through_source_id_and_aliases(env):
    ingest(env, snapshot())
    env.q(
        "INSERT INTO vulnerabilities (source, source_id, aliases, modified_at, source_artifact_sha256, source_entry, "
        "schema_version, adapter_version) VALUES "
        "('osv', 'GHSA-jfh8-c2jp-5v3q', %s, now(), repeat('a', 64), 'x.json', 1, 1), "
        "('osv', 'GHSA-none', %s, now(), repeat('a', 64), 'y.json', 1, 1)",
        [KEV_ID, "GHSA-x"],
        ["CVE-1999-0001"],
    )

    def status() -> dict[str, bool]:
        return dict(
            env.q(
                "SELECT v.source_id, s.in_kev FROM vulnerability_kev_status s "
                "JOIN vulnerabilities v ON v.id = s.vulnerability_id"
            )
        )

    found = status()
    assert found[KEV_ID] is True  # the cisa-kev row itself
    assert found["GHSA-jfh8-c2jp-5v3q"] is True  # an OSV advisory that aliases the CVE
    assert found["GHSA-none"] is False

    ingest(env, snapshot(drop=(KEV_ID,), version="2026.10.09"))
    assert status()["GHSA-jfh8-c2jp-5v3q"] is False  # a tombstone is absent


@pytest.mark.parametrize(
    ("label", "body"),
    [
        ("truncated", json.dumps(snapshot()).encode()[:300]),
        ("empty", json.dumps(snapshot(entries=[])).encode()),
        ("count", json.dumps({**snapshot(), "count": 99}).encode()),
        ("no list", b'{"title": "x"}'),
        ("not json", b"<html>maintenance</html>"),
    ],
)
def test_bad_snapshot_fails_without_changing_anything(env, label, body):
    ingest(env, snapshot())
    before = env.q("SELECT cve_id, removed_at, updated_at FROM kev_entries ORDER BY cve_id")

    outcome, sha = ingest(env, body)

    assert outcome == "failed", label
    assert env.run(sha)["status"] == "failed" and env.run(sha)["error"]
    assert env.q("SELECT cve_id, removed_at, updated_at FROM kev_entries ORDER BY cve_id") == before
    assert len(env.published) == 1  # only the first, good run announced


def test_shrink_guard_blocks_a_mass_removal_and_the_limit_can_be_raised(env):
    ingest(env, snapshot(entries=many(60)))
    shrunk = snapshot(entries=many(60)[:40], version="2026.10.09")  # 20 of 60 gone: 33%

    outcome, sha = ingest(env, shrunk)
    assert outcome == "failed"
    assert "would remove 20 of 60" in env.run(sha)["error"]
    assert len(active(env)) == 60

    # Operator override: raise the limit and the same artifact is retaken (a failed run is retried).
    assert handle(event(env, sha), env.deps(kev_max_removal_rate=0.5)) == "published"
    assert len(active(env)) == 40


def test_bad_entry_is_quarantined_and_is_not_mistaken_for_a_removal(env):
    ingest(env, snapshot())
    doc = snapshot(version="2026.10.09")
    doc["vulnerabilities"][0]["dateAdded"] = "not a date"
    broken = doc["vulnerabilities"][0]["cveID"]

    outcome, sha = ingest(env, doc)

    assert outcome == "published"
    assert env.run(sha)["quarantined"] == 1
    assert broken in active(env)  # still listed upstream, so still in KEV
    assert env.q("SELECT count(*) FROM normalization_failures WHERE artifact_sha256 = %s", sha) == [(1,)]


def test_a_zip_key_for_the_kev_source_is_dropped(env):
    sha = upload(env, snapshot())
    ev = event(env, sha)
    ev["artifact"]["key"] = f"raw/cisa-kev/none/{sha}.zip"
    assert handle(ev, env.deps()) == "dropped_untrusted"


def test_the_normalizer_role_cannot_delete_kev_entries(env):
    ingest(env, snapshot())
    with psycopg.connect(env.stores[-1].database_url, autocommit=True) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("DELETE FROM kev_entries")
