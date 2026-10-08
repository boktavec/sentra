"""Migration 010: comparable package names, the findings constraints and the correlator's grants."""

import psycopg
import pytest


@pytest.mark.parametrize(
    ("ecosystem", "namespace", "name", "expected"),
    [
        ("PyPI", None, "Django_Rest.Framework", "django-rest-framework"),
        ("PyPI", None, "django-rest.framework", "django-rest-framework"),  # what the parser stores
        ("npm", "@Angular", "Core", "@angular/core"),
        ("npm", None, "Lodash", "lodash"),
        ("Maven", "org.apache.logging.log4j", "log4j-core", "org.apache.logging.log4j:log4j-core"),
        ("Go", "github.com/foo", "bar", "github.com/foo/bar"),
        ("Go", "github.com/Foo", "bar", "github.com/Foo/bar"),  # exact: Go paths are case sensitive
        ("crates.io", None, "Serde", "Serde"),
    ],
)
def test_package_match_name(database, ecosystem: str, namespace: str | None, name: str, expected: str):
    with psycopg.connect(database[0]) as conn:
        row = conn.execute("SELECT package_match_name(%s, %s, %s)", (ecosystem, namespace, name)).fetchone()
    assert row == (expected,)


def test_both_sides_of_the_join_agree_on_scoped_and_pypi_names(admin):
    """A dependency stored as namespace + name must equal the advisory's combined package_name."""
    conn = admin
    user, org, project = admin.info_ids
    imp = conn.execute(
        "INSERT INTO sbom_imports (org_id, project_id, created_by, filename, status, object_key, expires_at) "
        "VALUES (%s, %s, %s, 'x.json', 'parsed', 'k', now()) RETURNING id",
        (org, project, user),
    ).fetchone()[0]
    columns = (
        "(import_id, org_id, project_id, purl, purl_type, namespace, name, version, ecosystem, scope, occurrences)"
    )
    for purl, purl_type, namespace, name, version, ecosystem in (
        ("pkg:npm/%40angular/core@1.0.0", "npm", "@angular", "core", "1.0.0", "npm"),
        ("pkg:pypi/foo-bar@1.0", "pypi", None, "foo-bar", "1.0", "PyPI"),
    ):
        conn.execute(
            f"INSERT INTO sbom_dependencies {columns} VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'required', 1)",  # noqa: S608
            (imp, org, project, purl, purl_type, namespace, name, version, ecosystem),
        )
    vuln = conn.execute(
        "INSERT INTO vulnerabilities (source, source_id, modified_at, source_artifact_sha256, source_entry, "
        "schema_version, adapter_version) VALUES ('osv', 'X-1', now(), %s, 'e', 1, 1) RETURNING id",
        ("a" * 64,),
    ).fetchone()[0]
    conn.execute(
        "INSERT INTO vulnerability_affected (id, vulnerability_id, ecosystem, package_name) VALUES "
        "(gen_random_uuid(), %s, 'npm', '@angular/core'), (gen_random_uuid(), %s, 'PyPI', 'Foo_Bar')",
        (vuln, vuln),
    )

    rows = conn.execute(
        "SELECT d.name FROM sbom_dependencies d JOIN vulnerability_affected a "
        "ON a.ecosystem = d.ecosystem AND a.match_name = d.match_name ORDER BY d.name"
    ).fetchall()

    conn.execute("DELETE FROM vulnerabilities WHERE id = %s", (vuln,))  # cascades to vulnerability_affected
    assert rows == [("core",), ("foo-bar",)]


def test_the_correlator_role_reads_inputs_and_writes_only_its_own_tables(database):
    with psycopg.connect(database[3], autocommit=True) as conn:
        for table in ("sbom_dependencies", "sbom_imports", "vulnerabilities", "vulnerability_affected", "findings"):
            conn.execute(f"SELECT 1 FROM {table} LIMIT 1")  # noqa: S608
        for statement in (
            "UPDATE sbom_dependencies SET scope = 'required'",
            "DELETE FROM findings",
            "UPDATE vulnerabilities SET summary = 'x'",
            "SELECT 1 FROM memberships",
            "SELECT 1 FROM projects",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(statement)  # type: ignore[arg-type]
