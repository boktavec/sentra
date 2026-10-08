import json

import psycopg
import pytest
from conftest import Harness, sha256

from pipeline.process import handle


def test_a_valid_sbom_becomes_parsed_with_its_hash(harness: Harness, valid_sbom: bytes):
    import_id = harness.add_import(valid_sbom)

    assert handle(harness.event(import_id), harness.deps()) == "parsed"

    row = harness.row(import_id)
    assert (row["status"], row["reason_code"]) == ("parsed", None)
    assert row["size_bytes"] == len(valid_sbom)
    assert row["sha256"] == sha256(valid_sbom)


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        (b"not json at all", "not_json"),
        (b"", "not_json"),
        (b"[1, 2, 3]", "not_cyclonedx"),
        (json.dumps({"bomFormat": "SPDX", "specVersion": "2.3"}).encode(), "not_cyclonedx"),
        (json.dumps({"bomFormat": "CycloneDX", "specVersion": "1.1"}).encode(), "unsupported_version"),
    ],
)
def test_an_invalid_file_is_rejected_with_a_reason(harness: Harness, body: bytes, reason: str):
    import_id = harness.add_import(body)

    assert handle(harness.event(import_id), harness.deps()) == "rejected"

    row = harness.row(import_id)
    assert (row["status"], row["reason_code"]) == ("rejected", reason)
    assert row["size_bytes"] == (len(body) or None)


def test_a_file_over_the_limit_is_rejected_as_too_large(harness: Harness, valid_sbom: bytes):
    harness.limits = type(harness.limits)(max_bytes=100, max_attempts=3, backoff_base=0.01, backoff_cap=0.02)
    import_id = harness.add_import(valid_sbom)

    assert handle(harness.event(import_id), harness.deps()) == "rejected"

    row = harness.row(import_id)
    assert (row["status"], row["reason_code"]) == ("rejected", "size")
    assert row["size_bytes"] == len(valid_sbom)
    assert row["sha256"] is None


def test_a_duplicate_delivery_changes_nothing(harness: Harness, valid_sbom: bytes):
    import_id = harness.add_import(valid_sbom)
    event = harness.event(import_id)
    assert handle(event, harness.deps()) == "parsed"
    first = harness.row(import_id)
    updated_at = harness.admin.execute("SELECT updated_at FROM sbom_imports WHERE id = %s", (import_id,)).fetchone()

    assert handle(event, harness.deps()) == "skipped_duplicate"

    assert harness.row(import_id) == first
    assert (
        harness.admin.execute("SELECT updated_at FROM sbom_imports WHERE id = %s", (import_id,)).fetchone()
        == updated_at
    )


def test_two_workers_racing_on_one_event_record_one_result(harness: Harness, valid_sbom: bytes):
    import_id = harness.add_import(valid_sbom)
    event = harness.event(import_id)

    outcomes = sorted([handle(event, harness.deps()), handle(event, harness.deps())])

    assert outcomes == ["parsed", "skipped_duplicate"]


@pytest.mark.parametrize("status", ["pending_upload", "validated", "rejected", "expired"])
def test_an_import_that_is_not_uploaded_is_left_alone(harness: Harness, valid_sbom: bytes, status: str):
    reason = "not_json" if status == "rejected" else None
    import_id = harness.add_import(valid_sbom, status=status, reason=reason)
    before = harness.row(import_id)

    assert handle(harness.event(import_id), harness.deps()) == "skipped_duplicate"

    assert harness.row(import_id) == before
    assert harness.flaky.reads == 0


def test_an_event_for_an_unknown_import_is_skipped(harness: Harness):
    known = harness.add_import(b"{}")

    event = harness.event(known, importId="00000000-0000-4000-8000-000000000000")

    assert handle(event, harness.deps()) == "skipped_missing"
    assert harness.row(known)["status"] == "uploaded"


def test_the_object_is_read_from_the_row_not_from_the_event(harness: Harness, valid_sbom: bytes):
    """An event naming another tenant's object must not make the pipeline read or record it."""
    other = b'{"bomFormat": "SPDX"}'
    harness.s3.put_object(Bucket=harness.bucket, Key="sbom/another-org/another-project/secret.json", Body=other)
    import_id = harness.add_import(valid_sbom)
    event = harness.event(import_id)
    event["artifact"]["key"] = "sbom/another-org/another-project/secret.json"

    assert handle(event, harness.deps()) == "parsed"

    assert harness.row(import_id)["sha256"] == sha256(valid_sbom)


def test_an_invalid_event_is_dropped_without_touching_the_database(harness: Harness, valid_sbom: bytes):
    import_id = harness.add_import(valid_sbom)
    before = harness.row(import_id)

    assert handle(harness.event(import_id, version=2), harness.deps()) == "dropped_invalid"
    assert handle(harness.event(import_id, unexpected="x"), harness.deps()) == "dropped_invalid"

    assert harness.row(import_id) == before


def test_a_transient_storage_failure_is_retried_with_backoff(harness: Harness, valid_sbom: bytes):
    import_id = harness.add_import(valid_sbom)
    harness.flaky.fail_reads = 2

    assert handle(harness.event(import_id), harness.deps()) == "parsed"

    assert harness.flaky.reads == 3
    assert harness.sleeps == [0.01, 0.02]


def test_exhausted_retries_record_processing_failed(harness: Harness, valid_sbom: bytes):
    import_id = harness.add_import(valid_sbom)
    harness.flaky.fail_reads = 99

    assert handle(harness.event(import_id), harness.deps()) == "failed"

    row = harness.row(import_id)
    assert (row["status"], row["reason_code"]) == ("rejected", "processing_failed")
    assert harness.flaky.reads == 3


def test_a_missing_object_ends_as_processing_failed(harness: Harness):
    import_id = harness.add_import(None)

    assert handle(harness.event(import_id), harness.deps()) == "failed"

    assert harness.row(import_id)["reason_code"] == "processing_failed"


def test_the_pipeline_role_can_only_record_validation_results(harness: Harness, database):
    import_id = harness.add_import(b"{}")
    with psycopg.connect(database[1], autocommit=True) as conn:
        assert conn.execute("SELECT count(*) FROM sbom_imports").fetchone() == (1,)
        for statement in (
            "UPDATE sbom_imports SET filename = 'x'",
            "UPDATE sbom_imports SET org_id = gen_random_uuid()",
            "UPDATE sbom_imports SET object_key = 'sbom/elsewhere'",
            "DELETE FROM sbom_imports",
            "SELECT * FROM sbom_outbox",
            "SELECT * FROM organizations",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(statement)  # type: ignore[arg-type]
        conn.execute(
            "UPDATE sbom_imports SET status = 'validated', sha256 = %s, size_bytes = 2, updated_at = now() "
            "WHERE id = %s",
            (sha256(b"{}"), import_id),
        )
    assert harness.row(import_id)["status"] == "validated"


def _bom(components: list[dict]) -> bytes:
    return json.dumps({"bomFormat": "CycloneDX", "specVersion": "1.6", "version": 1, "components": components}).encode()


def _lib(purl: str, **over: object) -> dict:
    return {"type": "library", "name": "x", "purl": purl, **over}


def _deps(harness: Harness, import_id: str) -> list[tuple]:
    return harness.admin.execute(
        "SELECT purl, purl_type, namespace, name, version, ecosystem, scope, occurrences, org_id, project_id "
        "FROM sbom_dependencies WHERE import_id = %s ORDER BY purl",
        (import_id,),
    ).fetchall()


def _counts(harness: Harness, import_id: str) -> tuple:
    return harness.admin.execute(
        "SELECT dependency_count, skipped_count FROM sbom_imports WHERE id = %s", (import_id,)
    ).fetchone()  # type: ignore[return-value]


def test_a_parsed_sbom_stores_normalized_dependencies_tied_to_its_import(harness: Harness, valid_sbom: bytes):
    import_id = harness.add_import(valid_sbom)

    assert handle(harness.event(import_id), harness.deps()) == "parsed"

    org, project = str(harness.org_id), str(harness.project_id)
    assert [
        (r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], str(r[8]), str(r[9])) for r in _deps(harness, import_id)
    ] == [
        ("pkg:npm/left-pad@1.3.0", "npm", None, "left-pad", "1.3.0", "npm", "required", 1, org, project),
        ("pkg:pypi/requests@2.32.3", "pypi", None, "requests", "2.32.3", "PyPI", "required", 1, org, project),
    ]
    assert _counts(harness, import_id) == (2, 0)


def test_duplicates_collapse_to_one_row_and_unusable_components_are_counted(harness: Harness):
    body = _bom(
        [
            _lib("pkg:npm/a@1.0.0", scope="optional"),
            _lib("pkg:npm/a@1.0.0", scope="required", components=[_lib("pkg:npm/a@1.0.0")]),
            _lib("pkg:deb/debian/curl@7.88?arch=amd64"),
            _lib("not a purl"),
            _lib("pkg:npm/no-version"),
            {"type": "library", "name": "no purl at all"},
        ]
    )
    import_id = harness.add_import(body)

    assert handle(harness.event(import_id), harness.deps()) == "parsed"

    rows = _deps(harness, import_id)
    assert [(r[0], r[5], r[6], r[7]) for r in rows] == [
        ("pkg:deb/debian/curl@7.88?arch=amd64", None, "required", 1),
        ("pkg:npm/a@1.0.0", "npm", "required", 3),
    ]
    assert _counts(harness, import_id) == (2, 3)


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        (_bom([]), "no_components"),
        (_bom([{"type": "library", "name": "no purl"}]), "no_components"),
        (_bom([_lib(f"pkg:npm/p{i}@1") for i in range(6)]), "too_many_components"),
    ],
)
def test_an_sbom_without_usable_components_or_over_the_cap_is_rejected_and_kept(
    harness: Harness, body: bytes, reason: str
):
    harness.limits = type(harness.limits)(max_components=5, max_attempts=3, backoff_base=0.01, backoff_cap=0.02)
    import_id = harness.add_import(body)

    assert handle(harness.event(import_id), harness.deps()) == "rejected"

    row = harness.row(import_id)
    assert (row["status"], row["reason_code"]) == ("rejected", reason)
    assert _deps(harness, import_id) == []
    assert harness.s3.head_object(Bucket=harness.bucket, Key=row["object_key"])  # the raw upload stays


def test_a_large_sbom_crosses_the_batch_boundary_and_stays_deterministic(harness: Harness):
    body = _bom([_lib(f"pkg:npm/pkg-{i}@1.0.{i}") for i in range(2500)])
    first = harness.add_import(body)
    second = harness.add_import(body)

    assert handle(harness.event(first), harness.deps()) == "parsed"
    assert handle(harness.event(second), harness.deps()) == "parsed"

    assert _counts(harness, first) == (2500, 0)
    assert [r[:8] for r in _deps(harness, first)] == [r[:8] for r in _deps(harness, second)]


def test_a_failure_while_writing_leaves_no_rows(harness: Harness):
    import_id = harness.add_import(_bom([_lib(f"pkg:npm/p{i}@1") for i in range(1500)]))
    # A NULL version in the second batch violates NOT NULL after the first batch was already inserted.
    deps = harness.deps()
    real = deps.imports.store_parsed

    def broken(imp, **kwargs):
        kwargs["dependencies"][1400].version = None  # type: ignore[assignment]
        return real(imp, **kwargs)

    deps.imports.store_parsed = broken  # type: ignore[method-assign]
    harness.limits = type(harness.limits)(max_attempts=1, backoff_base=0.01, backoff_cap=0.02)
    deps.limits = harness.limits

    assert handle(harness.event(import_id), deps) == "failed"

    assert _deps(harness, import_id) == []  # the first batch was rolled back with the rest
    assert harness.row(import_id)["reason_code"] == "processing_failed"


def test_reprocessing_replaces_the_rows_without_a_new_upload(harness: Harness):
    import_id = harness.add_import(_bom([_lib("pkg:npm/a@1"), _lib("pkg:npm/b@1")]))
    assert handle(harness.event(import_id), harness.deps()) == "parsed"
    # What `task sbom:reprocess` does: back to `uploaded`, ready for a re-published event.
    harness.admin.execute("UPDATE sbom_imports SET status = 'uploaded' WHERE id = %s", (import_id,))
    harness.s3.put_object(
        Bucket=harness.bucket,
        Key=harness.row(import_id)["object_key"],
        Body=_bom([_lib("pkg:npm/b@1"), _lib("pkg:npm/c@1"), _lib("pkg:npm/d@1")]),
    )

    assert handle(harness.event(import_id), harness.deps()) == "parsed"

    assert [r[0] for r in _deps(harness, import_id)] == ["pkg:npm/b@1", "pkg:npm/c@1", "pkg:npm/d@1"]
    assert _counts(harness, import_id) == (3, 0)


def test_the_pipeline_role_can_write_dependencies_but_not_change_them(harness: Harness, database):
    import_id = harness.add_import(_bom([_lib("pkg:npm/a@1")]))
    assert handle(harness.event(import_id), harness.deps()) == "parsed"
    with psycopg.connect(database[1], autocommit=True) as conn:
        for statement in ("UPDATE sbom_dependencies SET purl = 'x'", "UPDATE sbom_imports SET filename = 'x'"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(statement)  # type: ignore[arg-type]
