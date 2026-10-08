"""reconcile(project) against real Postgres as the sentra_correlator role (SENTRA-13)."""

import threading
import uuid
from typing import Any

import psycopg
import pytest

from pipeline.correlate.reconcile import reconcile


class World:
    """Imports, dependencies and advisories inserted as admin; reconcile runs as the correlator role."""

    def __init__(self, database, admin):
        self.admin = admin
        self.url = database[3]
        self.user, self.org, self.project = admin.info_ids
        self.admin.execute("TRUNCATE vulnerability_ranges, vulnerability_affected, vulnerabilities CASCADE")
        self._age = 0
        self.conn = psycopg.connect(self.url)

    def close(self) -> None:
        self.conn.close()

    def second_project(self) -> tuple[Any, Any]:
        org = self.admin.execute(
            "INSERT INTO organizations (name, slug, created_by) VALUES ('Other', 'other', %s) RETURNING id",
            (self.user,),
        ).fetchone()[0]
        project = self.admin.execute(
            "INSERT INTO projects (org_id, name, slug, created_by) VALUES (%s, 'App', 'app', %s) RETURNING id",
            (org, self.user),
        ).fetchone()[0]
        return org, project

    def sbom(self, deps: list[tuple], *, org=None, project=None, status="parsed") -> str:
        """An import whose dependencies are (purl, ecosystem, namespace, name, version[, scope]); newer on each call."""
        org, project = org or self.org, project or self.project
        self._age += 1
        import_id = self.admin.execute(
            "INSERT INTO sbom_imports (org_id, project_id, created_by, filename, status, object_key, expires_at, "
            "created_at) VALUES (%s, %s, %s, 'x.json', %s, %s, now(), now() + make_interval(secs => %s)) RETURNING id",
            (org, project, self.user, status, f"k-{uuid.uuid4()}", self._age),
        ).fetchone()[0]
        self.add_deps(import_id, deps, org, project)
        return str(import_id)

    def add_deps(self, import_id, deps: list[tuple], org=None, project=None) -> None:
        for purl, ecosystem, namespace, name, version, *scope in deps:
            self.admin.execute(
                "INSERT INTO sbom_dependencies (import_id, org_id, project_id, purl, purl_type, namespace, name, "
                "version, ecosystem, scope, occurrences) VALUES (%s, %s, %s, %s, 'x', %s, %s, %s, %s, %s, 1)",
                (import_id, org or self.org, project or self.project, purl, namespace, name, version, ecosystem,
                 scope[0] if scope else "required"),
            )  # fmt: skip

    def advisory(self, source_id: str, ecosystem: str, package: str, *, versions=(), ranges=(), withdrawn=False) -> str:
        """`ranges` is a list of (range_type, [(event_type, version), ...])."""
        vuln = self.admin.execute(
            "INSERT INTO vulnerabilities (source, source_id, modified_at, withdrawn_at, source_artifact_sha256, "
            "source_entry, schema_version, adapter_version) VALUES ('osv', %s, now(), %s, %s, 'e', 1, 1) RETURNING id",
            (source_id, "2026-01-01" if withdrawn else None, "a" * 64),
        ).fetchone()[0]
        self.affect(vuln, ecosystem, package, versions=versions, ranges=ranges)
        return str(vuln)

    def affect(self, vuln, ecosystem: str, package: str, *, versions=(), ranges=()) -> None:
        affected = uuid.uuid4()
        self.admin.execute(
            "INSERT INTO vulnerability_affected (id, vulnerability_id, ecosystem, package_name, versions) "
            "VALUES (%s, %s, %s, %s, %s)",
            (affected, vuln, ecosystem, package, list(versions)),
        )
        for i, (range_type, events) in enumerate(ranges):
            for j, (kind, version) in enumerate(events):
                self.admin.execute(
                    "INSERT INTO vulnerability_ranges VALUES (%s, %s, %s, %s, %s, %s)",
                    (affected, i, j, range_type, kind, version),
                )

    def rewrite_ranges(self, vuln: str, ranges) -> None:
        """What reprocessing an advisory does: its affected rows are deleted and re-inserted."""
        self.admin.execute("DELETE FROM vulnerability_affected WHERE vulnerability_id = %s", (vuln,))
        self.affect(vuln, "PyPI", "trac", ranges=ranges)

    def run(self, project=None):
        return reconcile(self.conn, str(project or self.project))

    def findings(self, project=None) -> list[dict[str, Any]]:
        cur = self.admin.execute(
            "SELECT f.purl, v.source_id, f.status, f.match_quality, f.match_reason, f.resolved_reason, f.scope, "
            "f.org_id, f.project_id, f.version, f.evidence FROM findings f JOIN vulnerabilities v "
            "ON v.id = f.vulnerability_id WHERE f.project_id = %s ORDER BY f.purl, v.source_id",
            (project or self.project,),
        )
        names = [d.name for d in cur.description or []]
        return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


@pytest.fixture
def world(database, admin):
    w = World(database, admin)
    yield w
    w.close()


TRAC = ("pkg:pypi/trac@0.9", "PyPI", None, "trac", "0.9")
FIXED_AT_0_10 = [("ECOSYSTEM", [("introduced", "0"), ("fixed", "0.10")])]


def test_a_matching_dependency_becomes_a_confirmed_finding_with_tenant_ids_from_the_dependency(world: World):
    world.sbom([TRAC])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)

    result = world.run()

    (f,) = world.findings()
    assert (f["source_id"], f["status"], f["match_quality"], f["match_reason"]) == (
        "PYSEC-1",
        "open",
        "confirmed",
        None,
    )
    assert (f["org_id"], f["project_id"], f["version"], f["scope"]) == (world.org, world.project, "0.9", "required")
    assert f["evidence"]["rule"] == "range" and f["evidence"]["package"] == "trac"
    assert (result.created, result.unchanged, result.resolved) == (1, 0, 0)


def test_a_dependency_outside_the_range_has_no_finding(world: World):
    world.sbom([("pkg:pypi/trac@0.10", "PyPI", None, "trac", "0.10")])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)

    world.run()

    assert world.findings() == []


def test_rerunning_changes_nothing_and_writes_nothing(world: World):
    world.sbom([TRAC])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)
    world.run()
    before = world.admin.execute("SELECT id, updated_at, last_seen_at, xmin::text FROM findings").fetchall()

    result = world.run()

    assert world.admin.execute("SELECT id, updated_at, last_seen_at, xmin::text FROM findings").fetchall() == before
    assert (result.created, result.updated, result.reopened, result.resolved, result.unchanged) == (0, 0, 0, 0, 1)


def test_scoped_npm_and_pypi_spellings_match_through_match_name(world: World):
    world.sbom(
        [
            ("pkg:npm/%40Angular/core@1.0.0", "npm", "@Angular", "core", "1.0.0"),
            ("pkg:pypi/foo-bar@1.0", "PyPI", None, "foo-bar", "1.0"),
        ]
    )
    world.advisory("GHSA-N", "npm", "@angular/core", ranges=[("SEMVER", [("introduced", "0"), ("fixed", "2.0.0")])])
    world.advisory("PYSEC-P", "PyPI", "Foo_Bar", versions=["1.0"])

    world.run()

    assert [(f["source_id"], f["match_quality"]) for f in world.findings()] == [
        ("GHSA-N", "confirmed"),
        ("PYSEC-P", "confirmed"),
    ]


def test_an_unparseable_version_is_an_unverifiable_finding_with_a_reason(world: World):
    world.sbom([("pkg:pypi/trac@latest", "PyPI", None, "trac", "latest")])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)

    world.run()

    (f,) = world.findings()
    assert (f["match_quality"], f["match_reason"], f["status"]) == ("unverifiable", "version_unparseable", "open")


def test_an_advisory_entry_with_no_version_data_is_unverifiable(world: World):
    world.sbom([TRAC])
    world.advisory("PYSEC-1", "PyPI", "trac")

    world.run()

    assert [(f["match_quality"], f["match_reason"]) for f in world.findings()] == [("unverifiable", "no_version_data")]


def test_dependencies_without_an_ecosystem_are_counted_not_matched(world: World):
    world.sbom([("pkg:deb/debian/curl@7.0", None, "debian", "curl", "7.0"), TRAC])
    world.advisory("DEB-1", "Debian", "curl", versions=["7.0"])

    result = world.run()

    assert world.findings() == [] and result.unmatchable == 1


def test_only_the_latest_parsed_import_counts(world: World):
    world.sbom([TRAC])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)
    world.run()
    world.sbom([("pkg:pypi/other@1.0", "PyPI", None, "other", "1.0")])
    world.sbom([TRAC], status="uploaded")  # newest, but not parsed, so it must not count

    world.run()

    (f,) = world.findings()
    assert (f["status"], f["resolved_reason"]) == ("resolved", "dependency_removed")


def test_a_finding_resolves_when_the_dependency_leaves_or_changes_version_and_reopens_when_it_returns(world: World):
    world.sbom([TRAC, ("pkg:pypi/gone@1.0", "PyPI", None, "gone", "1.0")])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)
    world.advisory("PYSEC-2", "PyPI", "gone", versions=["1.0"])
    world.run()

    world.sbom([("pkg:pypi/trac@0.9.1", "PyPI", None, "trac", "0.9.1")])  # trac moved, gone left
    result = world.run()

    by_purl = {f["purl"]: f for f in world.findings()}
    assert by_purl["pkg:pypi/gone@1.0"]["resolved_reason"] == "dependency_removed"
    assert (by_purl[TRAC[0]]["status"], by_purl[TRAC[0]]["resolved_reason"]) == ("resolved", "version_changed")
    assert by_purl["pkg:pypi/trac@0.9.1"]["status"] == "open"
    assert result.resolved == 2

    world.sbom([TRAC])  # back to the old version
    world.run()
    reopened = [f for f in world.findings() if f["purl"] == TRAC[0]]
    assert [(f["status"], f["resolved_reason"]) for f in reopened] == [("open", None)]


def test_a_withdrawn_advisory_resolves_its_findings(world: World):
    world.sbom([TRAC])
    vuln = world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)
    world.run()

    world.admin.execute("UPDATE vulnerabilities SET withdrawn_at = now(), updated_at = now() WHERE id = %s", (vuln,))
    world.run()

    (f,) = world.findings()
    assert (f["status"], f["resolved_reason"]) == ("resolved", "advisory_withdrawn")


def test_an_advisory_that_is_rewritten_to_a_fix_resolves_and_one_that_widens_reopens(world: World):
    world.sbom([TRAC])
    vuln = world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)
    world.run()

    world.rewrite_ranges(vuln, [("ECOSYSTEM", [("introduced", "0"), ("fixed", "0.5")])])
    world.run()
    (f,) = world.findings()
    assert (f["status"], f["resolved_reason"]) == ("resolved", "advisory_updated")

    world.rewrite_ranges(vuln, [("ECOSYSTEM", [("introduced", "0"), ("fixed", "1.0")])])
    result = world.run()
    (f,) = world.findings()
    assert f["status"] == "open" and result.reopened == 1


def test_a_changed_scope_or_evidence_updates_the_finding_once(world: World):
    world.sbom([TRAC + ("optional",)])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)
    world.run()

    world.sbom([TRAC + ("required",)])
    first, second = world.run(), world.run()

    assert world.findings()[0]["scope"] == "required"
    assert (first.updated, second.unchanged) == (1, 1)


def test_reprocessing_an_sbom_replaces_dependency_rows_without_touching_findings(world: World):
    import_id = world.sbom([TRAC])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)
    world.run()
    before = world.admin.execute("SELECT id, updated_at FROM findings").fetchall()

    world.admin.execute("DELETE FROM sbom_dependencies WHERE import_id = %s", (import_id,))
    world.add_deps(import_id, [TRAC])
    result = world.run()

    assert world.admin.execute("SELECT id, updated_at FROM findings").fetchall() == before
    assert result.unchanged == 1


def test_the_same_package_in_two_tenants_gives_independent_findings_with_their_own_ids(world: World):
    org2, project2 = world.second_project()
    world.sbom([TRAC])
    world.sbom([TRAC], org=org2, project=project2)
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)

    world.run()
    world.run(project2)

    (a,), (b,) = world.findings(), world.findings(project2)
    assert (a["org_id"], a["project_id"]) == (world.org, world.project)
    assert (b["org_id"], b["project_id"]) == (org2, project2)


def test_reconciling_one_project_never_touches_another(world: World):
    org2, project2 = world.second_project()
    world.sbom([TRAC], org=org2, project=project2)
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)
    world.run(project2)
    before = world.findings(project2)

    world.run()  # the other project has no import

    assert world.findings(project2) == before


def test_concurrent_reconciles_of_one_project_agree(world: World):
    world.sbom([TRAC, ("pkg:pypi/b@1.0", "PyPI", None, "b", "1.0")])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)
    world.advisory("PYSEC-2", "PyPI", "b", versions=["1.0"])
    errors: list[Exception] = []

    def work() -> None:
        try:
            with psycopg.connect(world.url) as conn:
                for _ in range(5):
                    reconcile(conn, str(world.project))
        except Exception as e:  # pragma: no cover - failure path
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(4)]
    [t.start() for t in threads]
    [t.join() for t in threads]

    assert errors == []
    assert [(f["source_id"], f["status"]) for f in world.findings()] == [
        ("PYSEC-2", "open"),
        ("PYSEC-1", "open"),
    ]  # ordered by purl


def test_one_advisory_with_two_matching_entries_keeps_one_finding_and_prefers_confirmed(world: World):
    world.sbom([TRAC])
    vuln = world.advisory("PYSEC-1", "PyPI", "trac")  # no version data: unverifiable
    world.affect(vuln, "PyPI", "trac", ranges=FIXED_AT_0_10)  # a second entry that confirms

    world.run()

    (f,) = world.findings()
    assert f["match_quality"] == "confirmed"
