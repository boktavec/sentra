"""The grouper pass end to end as sentra_grouper: real tables, real alias queries."""

import psycopg
import pytest

from pipeline.group.components import group_id
from pipeline.group.run import run_once


@pytest.fixture
def grouper(database, admin):
    admin.execute(
        "TRUNCATE group_conflicts, vulnerability_group_members, vulnerability_groups, group_runs, group_state, "
        "findings, vulnerability_ranges, vulnerability_affected, vulnerabilities CASCADE"
    )
    conn = psycopg.connect(database[4], autocommit=True)
    yield admin, conn
    conn.close()


def advisory(admin, source_id: str, aliases=(), package="django", ecosystem="PyPI", source="osv") -> str:
    vuln = admin.execute(
        "INSERT INTO vulnerabilities (source, source_id, aliases, modified_at, source_artifact_sha256, source_entry, "
        "schema_version, adapter_version) VALUES (%s, %s, %s, now(), %s, 'e', 1, 1) RETURNING id",
        (source, source_id, list(aliases), "a" * 64),
    ).fetchone()[0]
    admin.execute(
        "INSERT INTO vulnerability_affected (id, vulnerability_id, ecosystem, package_name) "
        "VALUES (gen_random_uuid(), %s, %s, %s)",
        (vuln, ecosystem, package),
    )
    return str(vuln)


def touch(admin, *ids: str) -> None:
    admin.execute("UPDATE vulnerabilities SET updated_at = clock_timestamp() WHERE id = ANY(%s::uuid[])", (list(ids),))


def groups_of(admin) -> dict[str, str]:
    rows = admin.execute(
        "SELECT v.source_id, m.group_id::text FROM vulnerability_group_members m "
        "JOIN vulnerabilities v ON v.id = m.vulnerability_id"
    ).fetchall()
    return dict(rows)


def test_ghsa_pysec_and_cve_become_one_group_and_no_advisory_is_lost(grouper):
    admin, conn = grouper
    advisory(admin, "GHSA-aaaa", ["CVE-2024-1"])
    advisory(admin, "PYSEC-2024-1", ["CVE-2024-1"])
    advisory(admin, "MAL-2024-9", package="other")
    run_once(conn)
    got = groups_of(admin)
    assert got["GHSA-aaaa"] == got["PYSEC-2024-1"] == group_id("osv", "GHSA-aaaa")
    assert got["MAL-2024-9"] == group_id("osv", "MAL-2024-9")
    assert admin.execute("SELECT count(*) FROM vulnerabilities").fetchone()[0] == 3  # provenance rows untouched


def test_rerun_and_full_rebuild_give_identical_groups(grouper):
    admin, conn = grouper
    advisory(admin, "GHSA-aaaa", ["CVE-2024-1"])
    advisory(admin, "PYSEC-2024-1", ["CVE-2024-1"])
    run_once(conn)
    first = groups_of(admin)
    run_once(conn)
    assert groups_of(admin) == first
    admin.execute("TRUNCATE group_conflicts, vulnerability_group_members, vulnerability_groups, group_state CASCADE")
    run_once(conn)
    assert groups_of(admin) == first


def test_ambiguous_component_is_left_as_singletons_with_a_conflict_row(grouper):
    admin, conn = grouper
    advisory(admin, "GHSA-a", ["X-1"], package="left-pad", ecosystem="npm")
    advisory(admin, "GHSA-b", ["X-1"])
    run_once(conn)
    got = groups_of(admin)
    assert got["GHSA-a"] != got["GHSA-b"]
    reasons = admin.execute("SELECT reason FROM group_conflicts").fetchall()
    assert reasons == [("no_common_package",)] * 2


def test_late_advisory_bridges_two_groups_and_old_id_points_at_the_survivor(grouper):
    admin, conn = grouper
    advisory(admin, "GHSA-b", ["LINK-1"])
    advisory(admin, "GHSA-c", ["LINK-2"])
    run_once(conn)
    assert groups_of(admin)["GHSA-b"] != groups_of(admin)["GHSA-c"]
    advisory(admin, "GHSA-a", ["LINK-1", "LINK-2"])  # new, smallest key, shares one identifier with each
    run_once(conn, overlap_seconds=0)
    got = groups_of(admin)
    survivor = group_id("osv", "GHSA-a")
    assert got["GHSA-a"] == got["GHSA-b"] == got["GHSA-c"] == survivor
    merged = dict(admin.execute("SELECT id::text, merged_into::text FROM vulnerability_groups").fetchall())
    assert merged[group_id("osv", "GHSA-b")] == survivor
    assert merged[survivor] is None


def test_alias_removed_by_a_newer_advisory_splits_the_group(grouper):
    admin, conn = grouper
    a = advisory(admin, "GHSA-a", ["LINK-1"])
    advisory(admin, "GHSA-b", ["LINK-1"])
    run_once(conn)
    assert groups_of(admin)["GHSA-a"] == groups_of(admin)["GHSA-b"]
    admin.execute("UPDATE vulnerabilities SET aliases = '{}' WHERE id = %s", (a,))
    touch(admin, a)
    run_once(conn, overlap_seconds=0)
    got = groups_of(admin)
    assert got["GHSA-a"] != got["GHSA-b"]
    assert got["GHSA-b"] == group_id("osv", "GHSA-b")


def test_second_grouper_cannot_run_concurrently(grouper, database):
    _, conn = grouper
    other = psycopg.connect(database[4], autocommit=True)
    other.execute("SELECT pg_advisory_lock(hashtext('sentra_grouper'))")
    try:
        assert run_once(conn) is None
    finally:
        other.close()


def test_kev_stub_row_is_grouped_with_the_osv_advisory_that_lists_its_cve(grouper):
    admin, conn = grouper
    advisory(admin, "GHSA-aaaa", ["CVE-2024-1"])
    kev = admin.execute(
        "INSERT INTO vulnerabilities (source, source_id, modified_at, source_artifact_sha256, source_entry, "
        "schema_version, adapter_version) VALUES ('cisa-kev', 'CVE-2024-1', now(), %s, 'e', 1, 1) RETURNING id",
        ("b" * 64,),
    ).fetchone()[0]
    run_once(conn)
    got = groups_of(admin)
    assert got["CVE-2024-1"] == got["GHSA-aaaa"] == group_id("osv", "GHSA-aaaa")
    assert admin.execute("SELECT count(*) FROM group_conflicts").fetchone()[0] == 0
    assert kev
