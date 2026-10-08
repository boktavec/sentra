import json

import psycopg
import pytest
from conftest import Harness, sha256

from pipeline.process import handle


def test_a_valid_sbom_becomes_validated_with_its_hash(harness: Harness, valid_sbom: bytes):
    import_id = harness.add_import(valid_sbom)

    assert handle(harness.event(import_id), harness.deps()) == "validated"

    row = harness.row(import_id)
    assert (row["status"], row["reason_code"]) == ("validated", None)
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
    assert handle(event, harness.deps()) == "validated"
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

    assert outcomes == ["skipped_duplicate", "validated"]


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

    assert handle(event, harness.deps()) == "validated"

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

    assert handle(harness.event(import_id), harness.deps()) == "validated"

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
