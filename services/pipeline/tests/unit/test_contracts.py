import uuid

import pytest

from pipeline import contracts


def event(**over: object) -> dict:
    base = {
        "eventId": str(uuid.uuid4()),
        "type": "sbom.uploaded",
        "version": 1,
        "timestamp": "2026-10-08T09:00:00Z",
        "correlationId": "corr-1",
        "importId": str(uuid.uuid4()),
        "orgId": str(uuid.uuid4()),
        "projectId": str(uuid.uuid4()),
        "artifact": {"bucket": "sentra-raw", "key": "sbom/o/p/i.json", "sizeBytes": 1234},
    }
    return {**base, **over}


def test_a_well_formed_event_is_accepted():
    contracts.validate("sbom.uploaded", event())


@pytest.mark.parametrize(
    "over",
    [
        {"importId": "not-a-uuid"},
        {"version": 2},
        {"type": "artifact.ingested"},
        {"correlationId": "has spaces"},
        {"artifact": {"bucket": "b", "key": "k", "sizeBytes": 0}},
        {"artifact": {"bucket": "b", "key": "k", "sizeBytes": 5, "url": "http://example.test/x"}},
        {"unexpected": "field"},
    ],
)
def test_a_malformed_event_is_rejected(over: dict):
    with pytest.raises(contracts.InvalidEvent):
        contracts.validate("sbom.uploaded", event(**over))


def test_a_missing_field_is_rejected():
    e = event()
    del e["orgId"]
    with pytest.raises(contracts.InvalidEvent):
        contracts.validate("sbom.uploaded", e)
