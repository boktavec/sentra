"""GHSA normalization against real Postgres and S3, using real GitHub advisories, and its overlap with OSV."""

import hashlib
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import psycopg
import pytest
from correlate_support import World
from normalize_support import record as osv_record

from pipeline.group.run import run_once
from pipeline.normalize.adapters import ghsa
from pipeline.normalize.process import handle

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "ghsa"
DUCKDB = "GHSA-6mcc-q3mg-3qg6"  # also an OSV record (osv/ghsa_overlap.json): the same advisory from two sources
DUCKDB_PACKAGE = (
    "pkg:pypi/llama-index-vector-stores-duckdb@0.12.20",
    "PyPI",
    None,
    "llama-index-vector-stores-duckdb",
    "0.12.20",
)


def advisory(name: str, **over: Any) -> dict[str, Any]:
    return {**json.loads((FIXTURES / f"{name}.json").read_text()), **over}


def bundle(*pages: list[Any] | bytes) -> bytes:
    """What the crawler stores: one zip entry per API page, each the page body."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, page in enumerate(pages, 1):
            zf.writestr(f"page-{i:05d}.json", page if isinstance(page, bytes) else json.dumps(page, indent=2))
    return buf.getvalue()


def ingest_ghsa(env, data: bytes, **limits: Any) -> tuple[str, str]:
    sha = hashlib.sha256(data).hexdigest()
    key = f"raw/ghsa/none/{sha}.zip"
    env.s3.put_object(Bucket=env.bucket, Key=key, Body=data)
    event = env.event(sha, source="ghsa", ecosystem="none")
    event["artifact"]["key"] = key
    return handle(event, env.deps(**limits)), sha


def ingest_osv(env, *names: str) -> str:
    _, sha = env.upload({f"{osv_record(n)['id']}.json": osv_record(n) for n in names})
    assert handle(env.event(sha), env.deps()) == "published"
    return sha


def ghsa_row(env, source_id: str) -> tuple[Any, ...]:
    (row,) = env.q(
        "SELECT withdrawn_at, modified_at, aliases, source_artifact_sha256, source_entry, adapter_version, "
        "cvss_version FROM vulnerabilities WHERE source = 'ghsa' AND source_id = %s",
        source_id,
    )
    return row


def test_a_bundle_is_normalized_with_provenance_pointing_at_the_page_and_index(env):
    pages = [[advisory("npm_cvss3"), advisory("pip_range_osv_overlap")], [advisory("multi_range")]]
    outcome, sha = ingest_ghsa(env, bundle(*pages))

    assert outcome == "published"
    rows = env.q(
        "SELECT source_id, source_entry, source_artifact_sha256, adapter_version FROM vulnerabilities "
        "WHERE source = 'ghsa' ORDER BY source_entry"
    )
    assert rows == [
        (pages[0][0]["ghsa_id"], "page-00001.json[0]", sha, ghsa.ADAPTER_VERSION),
        (pages[0][1]["ghsa_id"], "page-00001.json[1]", sha, ghsa.ADAPTER_VERSION),
        (pages[1][0]["ghsa_id"], "page-00002.json[0]", sha, ghsa.ADAPTER_VERSION),
    ]
    assert env.run(sha) == {"status": "published", "upserted": 3, "unchanged": 0, "quarantined": 0, "error": None}
    (event,) = env.published
    assert (event["source"], event["ecosystem"], event["counts"]["upserted"]) == ("ghsa", "none", 3)


def test_affected_packages_ranges_aliases_and_cvss_are_stored(env):
    ingest_ghsa(env, bundle([advisory("pip_range_osv_overlap"), advisory("exact_version")]))

    ranges = env.q(
        "SELECT a.ecosystem, a.package_name, r.range_type, r.event_type, r.event_version "
        "FROM vulnerability_ranges r JOIN vulnerability_affected a ON a.id = r.affected_id "
        "JOIN vulnerabilities v ON v.id = a.vulnerability_id WHERE v.source_id = %s ORDER BY r.event_index",
        DUCKDB,
    )
    assert ranges == [
        ("PyPI", "llama-index-vector-stores-duckdb", "ECOSYSTEM", "introduced", "0.12.19"),
        ("PyPI", "llama-index-vector-stores-duckdb", "ECOSYSTEM", "fixed", "0.12.21"),
    ]
    assert ghsa_row(env, DUCKDB)[2] == ["CVE-2025-1750"] and ghsa_row(env, DUCKDB)[6] is not None
    (versions,) = env.q(
        "SELECT a.versions FROM vulnerability_affected a JOIN vulnerabilities v ON v.id = a.vulnerability_id "
        "WHERE v.source_id = %s",
        advisory("exact_version")["ghsa_id"],
    )
    assert versions == (["3.9.0"],)


def test_a_withdrawn_advisory_is_stored_with_its_timestamp_not_dropped(env):
    raw = advisory("withdrawn")
    ingest_ghsa(env, bundle([raw]))
    assert ghsa_row(env, raw["ghsa_id"])[0].strftime("%Y-%m-%dT%H:%M:%SZ") == raw["withdrawn_at"]


def test_a_bad_advisory_is_quarantined_by_page_and_index_and_the_rest_are_stored(env):
    bad = advisory(
        "npm_cvss3", vulnerabilities=[{"package": {"ecosystem": "npm", "name": "x"}, "vulnerable_version_range": "> 1"}]
    )
    outcome, sha = ingest_ghsa(env, bundle([advisory("pip_range_osv_overlap"), bad], [advisory("no_cve")]))

    assert outcome == "published"
    assert env.run(sha)["upserted"] == 2 and env.run(sha)["quarantined"] == 1
    ((entry, error),) = env.q("SELECT entry_name, error FROM normalization_failures WHERE artifact_sha256 = %s", sha)
    assert entry == "page-00001.json[1]" and "exclusive lower bound" in error


def test_a_page_that_is_not_an_array_is_one_quarantined_entry(env):
    _, sha = ingest_ghsa(env, bundle([advisory("no_cve")], b'{"message": "Server Error"}'))
    ((entry, error),) = env.q("SELECT entry_name, error FROM normalization_failures WHERE artifact_sha256 = %s", sha)
    assert entry == "page-00002.json" and "not a JSON array" in error


def test_replaying_the_same_bundle_changes_nothing(env):
    data = bundle([advisory("npm_cvss3"), advisory("withdrawn")])
    assert ingest_ghsa(env, data)[0] == "published"
    before = env.q("SELECT id, updated_at FROM vulnerabilities ORDER BY id")
    assert ingest_ghsa(env, data)[0] == "skipped_duplicate"
    assert env.q("SELECT id, updated_at FROM vulnerabilities ORDER BY id") == before and len(env.published) == 1


def test_an_incremental_bundle_with_overlap_rows_updates_only_what_changed(env):
    first, second = advisory("npm_cvss3"), advisory("pip_range_osv_overlap")
    ingest_ghsa(env, bundle([first, second]))
    newer = {**second, "updated_at": "2026-10-09T12:00:00Z", "summary": "edited upstream"}

    _, sha = ingest_ghsa(env, bundle([first, newer]))  # `first` is the re-fetched overlap row

    assert (env.run(sha)["upserted"], env.run(sha)["unchanged"]) == (1, 1)
    assert env.q("SELECT summary FROM vulnerabilities WHERE source_id = %s", DUCKDB) == [("edited upstream",)]


def test_an_older_copy_of_an_advisory_never_overwrites_a_newer_one(env):
    current = advisory("pip_range_osv_overlap", updated_at="2026-10-09T12:00:00Z", summary="current")
    ingest_ghsa(env, bundle([current]))
    ingest_ghsa(env, bundle([advisory("pip_range_osv_overlap")]))  # an older page, replayed late
    assert env.q("SELECT summary FROM vulnerabilities WHERE source_id = %s", DUCKDB) == [("current",)]


def test_a_later_withdrawal_resolves_the_open_finding(env, world: World):
    raw = advisory("pip_range_osv_overlap")
    ingest_ghsa(env, bundle([raw]))
    world.sbom([DUCKDB_PACKAGE])
    world.run()
    (f,) = world.findings()
    assert (f["source_id"], f["status"], f["match_quality"]) == (DUCKDB, "open", "confirmed")

    withdrawn = {**raw, "updated_at": "2026-10-10T00:00:00Z", "withdrawn_at": "2026-10-10T00:00:00Z"}
    ingest_ghsa(env, bundle([withdrawn]))
    world.run()

    (f,) = world.findings()
    assert (f["status"], f["resolved_reason"]) == ("resolved", "advisory_withdrawn")


def group_membership(env, conn: psycopg.Connection) -> dict[tuple[str, str], str]:
    run_once(conn)
    return {
        (source, source_id): group_id
        for source, source_id, group_id in env.q(
            "SELECT v.source, v.source_id, m.group_id::text FROM vulnerability_group_members m "
            "JOIN vulnerabilities v ON v.id = m.vulnerability_id"
        )
    }


@pytest.fixture
def grouper(database):
    conn = psycopg.connect(database[4], autocommit=True)
    yield conn
    conn.close()


def reset(env) -> None:
    env.q(
        "TRUNCATE group_conflicts, vulnerability_group_members, vulnerability_groups, group_runs, group_state, "
        "findings, vulnerability_ranges, vulnerability_affected, vulnerabilities, normalization_runs, "
        "normalization_failures CASCADE"
    )


def test_the_same_advisory_from_osv_and_ghsa_groups_identically_in_either_ingest_order(env, grouper):
    ghsa_bundle = bundle([advisory("pip_range_osv_overlap"), advisory("npm_cvss3")])

    ingest_osv(env, "ghsa_overlap")
    ingest_ghsa(env, ghsa_bundle)
    osv_first = group_membership(env, grouper)

    reset(env)
    ingest_ghsa(env, ghsa_bundle)
    ingest_osv(env, "ghsa_overlap")
    ghsa_first = group_membership(env, grouper)

    assert osv_first == ghsa_first
    assert osv_first[("osv", DUCKDB)] == osv_first[("ghsa", DUCKDB)]  # one group for the two rows...
    assert (
        len(env.q("SELECT id FROM vulnerabilities WHERE source_id = %s", DUCKDB)) == 2
    )  # ...provenance rows both kept
    others = {g for k, g in osv_first.items() if k[1] != DUCKDB}
    assert len(others) == 1 and others != {osv_first[("osv", DUCKDB)]}  # the unrelated advisory is its own group


def test_a_ghsa_advisory_without_an_osv_twin_is_its_own_group(env, grouper):
    ingest_ghsa(env, bundle([advisory("no_cve")]))
    ((key, _),) = group_membership(env, grouper).items()
    assert key == ("ghsa", advisory("no_cve")["ghsa_id"])


def test_osv_data_is_not_touched_by_ghsa_ingest(env):
    ingest_osv(env, "ghsa_overlap")
    before = env.q("SELECT id, modified_at, updated_at FROM vulnerabilities WHERE source = 'osv'")
    ingest_ghsa(env, bundle([advisory("pip_range_osv_overlap")]))
    assert env.q("SELECT id, modified_at, updated_at FROM vulnerabilities WHERE source = 'osv'") == before


def with_range(raw: dict[str, Any], expression: str, updated_at: str) -> dict[str, Any]:
    vuln = {**raw["vulnerabilities"][0], "vulnerable_version_range": expression}
    return {**raw, "updated_at": updated_at, "vulnerabilities": [vuln]}


def stored_ranges(env) -> list[tuple[Any, ...]]:
    return env.q(
        "SELECT a.id::text, r.event_type, r.event_version FROM vulnerability_ranges r "
        "JOIN vulnerability_affected a ON a.id = r.affected_id JOIN vulnerabilities v ON v.id = a.vulnerability_id "
        "WHERE v.source = 'ghsa' AND v.source_id = %s ORDER BY r.event_index",
        DUCKDB,
    )


def test_the_same_advisory_twice_in_one_bundle_keeps_only_the_newest_copys_affected_rows(env):
    base = advisory("pip_range_osv_overlap")
    old = with_range(base, "< 9.0.0", "2026-10-01T00:00:00Z")
    new = with_range(base, ">= 0.12.19, < 0.12.21", "2026-10-02T00:00:00Z")

    ingest_ghsa(env, bundle([old], [new]))  # an advisory edited while the crawler paginated

    rows = stored_ranges(env)
    assert [(e, v) for _, e, v in rows] == [("introduced", "0.12.19"), ("fixed", "0.12.21")]
    assert len({r[0] for r in rows}) == 1  # one affected row, not one per copy

    ingest_ghsa(env, bundle([new], [advisory("npm_cvss3")]))  # the next run's overlap re-fetch changes nothing
    assert [(e, v) for _, e, v in stored_ranges(env)] == [("introduced", "0.12.19"), ("fixed", "0.12.21")]
    assert len({r[0] for r in stored_ranges(env)}) == 1


def test_the_older_copy_later_in_a_bundle_does_not_replace_the_newer_one(env):
    base = advisory("pip_range_osv_overlap")
    new = with_range(base, ">= 0.12.19, < 0.12.21", "2026-10-02T00:00:00Z")
    old = with_range(base, "< 9.0.0", "2026-10-01T00:00:00Z")
    ingest_ghsa(env, bundle([new], [old]))
    assert [(e, v) for _, e, v in stored_ranges(env)] == [("introduced", "0.12.19"), ("fixed", "0.12.21")]
