"""sbom.parsed is published once a parse commits, and again on redelivery (ADR 0002: crash recovery)."""

import pytest
from conftest import Harness

from pipeline import contracts
from pipeline.process import handle


def test_a_parsed_import_publishes_sbom_parsed_with_tenant_ids_from_the_row(harness: Harness, valid_sbom: bytes):
    import_id = harness.add_import(valid_sbom)

    assert handle(harness.event(import_id), harness.deps()) == "parsed"

    (event,) = harness.published
    contracts.validate("sbom.parsed", event)
    count = harness.admin.execute("SELECT count(*) FROM sbom_dependencies WHERE import_id = %s", (import_id,))
    assert event["importId"] == import_id
    assert (event["orgId"], event["projectId"]) == (str(harness.org_id), str(harness.project_id))
    assert event["dependencyCount"] == count.fetchone()[0]  # type: ignore[index]


def test_redelivery_republishes_with_the_same_event_id(harness: Harness, valid_sbom: bytes):
    import_id = harness.add_import(valid_sbom)
    event = harness.event(import_id)
    assert handle(event, harness.deps()) == "parsed"

    assert handle(event, harness.deps()) == "skipped_duplicate"

    first, again = harness.published
    assert first["eventId"] == again["eventId"]


def test_a_crash_between_commit_and_publish_is_recovered_by_redelivery(harness: Harness, valid_sbom: bytes):
    import_id = harness.add_import(valid_sbom)
    event = harness.event(import_id)
    harness.publish_fails = 1

    with pytest.raises(ConnectionError):
        handle(event, harness.deps())
    assert harness.row(import_id)["status"] == "parsed"
    assert harness.published == []

    handle(event, harness.deps())

    assert len(harness.published) == 1


@pytest.mark.parametrize("status", ["rejected", "validated", "pending_upload", "expired"])
def test_an_import_that_is_not_parsed_publishes_nothing(harness: Harness, valid_sbom: bytes, status: str):
    reason = "not_json" if status == "rejected" else None
    import_id = harness.add_import(valid_sbom, status=status, reason=reason)

    handle(harness.event(import_id), harness.deps())

    assert harness.published == []


def test_a_rejected_upload_publishes_nothing(harness: Harness):
    import_id = harness.add_import(b"not json")

    assert handle(harness.event(import_id), harness.deps()) == "rejected"

    assert harness.published == []
