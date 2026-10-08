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


def normalized(**over: object) -> dict:
    base = {
        "eventId": str(uuid.uuid4()),
        "type": "vulnerabilities.normalized",
        "version": 1,
        "timestamp": "2026-10-08T09:00:00Z",
        "correlationId": "corr-1",
        "source": "osv",
        "ecosystem": "PyPI",
        "artifactSha256": "a" * 64,
        "adapterVersion": 1,
        "counts": {"upserted": 1, "unchanged": 0, "quarantined": 0},
    }
    return {**base, **over}


def test_a_vulnerabilities_normalized_event_is_accepted():
    contracts.validate("vulnerabilities.normalized", normalized())


@pytest.mark.parametrize(
    "over",
    [
        {"artifactSha256": "short"},
        {"adapterVersion": 0},
        {"counts": {"upserted": -1, "unchanged": 0, "quarantined": 0}},
        {"counts": {"upserted": 1, "unchanged": 0}},
        {"unexpected": "field"},
    ],
)
def test_a_malformed_vulnerabilities_normalized_event_is_rejected(over: dict):
    with pytest.raises(contracts.InvalidEvent):
        contracts.validate("vulnerabilities.normalized", normalized(**over))


def test_the_canonical_model_rejects_unknown_fields():
    doc = {
        "source": "osv", "sourceId": "X-1", "aliases": [], "summary": None, "details": None, "publishedAt": None,
        "modifiedAt": "2026-10-08T09:00:00Z", "withdrawnAt": None, "severity": [], "references": [], "affected": [],
    }  # fmt: skip
    contracts.validate_model("vulnerability", doc)
    with pytest.raises(contracts.InvalidEvent):
        contracts.validate_model("vulnerability", {**doc, "extra": 1})


def parsed(**over: object) -> dict:
    base = {
        "eventId": str(uuid.uuid4()),
        "type": "sbom.parsed",
        "version": 1,
        "timestamp": "2026-10-08T09:00:00Z",
        "correlationId": "corr-1",
        "importId": str(uuid.uuid4()),
        "orgId": str(uuid.uuid4()),
        "projectId": str(uuid.uuid4()),
        "dependencyCount": 12,
    }
    return {**base, **over}


def test_a_well_formed_sbom_parsed_event_is_accepted():
    contracts.validate("sbom.parsed", parsed())


@pytest.mark.parametrize(
    "over",
    [
        {"importId": "not-a-uuid"},
        {"version": 2},
        {"dependencyCount": -1},
        {"dependencyCount": "12"},
        {"artifact": {"bucket": "b", "key": "k", "sizeBytes": 1}},
    ],
)
def test_a_malformed_sbom_parsed_event_is_rejected(over: dict):
    with pytest.raises(contracts.InvalidEvent):
        contracts.validate("sbom.parsed", parsed(**over))
