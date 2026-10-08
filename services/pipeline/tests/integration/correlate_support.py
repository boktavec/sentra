"""Shared setup for the correlator tests: tenant data inserted as admin, matching run as sentra_correlator."""

import uuid
from typing import Any

import psycopg

from pipeline.correlate.reconcile import reconcile

TRAC = ("pkg:pypi/trac@0.9", "PyPI", None, "trac", "0.9")
FIXED_AT_0_10 = [("ECOSYSTEM", [("introduced", "0"), ("fixed", "0.10")])]


class World:
    """Imports, dependencies and advisories inserted as admin; reconcile runs as the correlator role."""

    def __init__(self, database, admin):
        self.admin = admin
        self.url = database[3]
        self.user, self.org, self.project = admin.info_ids
        self.admin.execute(
            "TRUNCATE vulnerability_ranges, vulnerability_affected, vulnerabilities, correlation_state CASCADE"
        )
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
