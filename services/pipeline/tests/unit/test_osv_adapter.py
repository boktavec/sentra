import json
from pathlib import Path

import pytest

from pipeline.contracts import InvalidEvent
from pipeline.normalize import model
from pipeline.normalize.adapters.osv import NormalizeError, normalize

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "osv"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


@pytest.mark.parametrize("name", ["ecosystem_pysec", "git", "malware", "semver_fixed", "versions_only", "withdrawn"])
def test_real_records_normalize_and_validate(name):
    record = normalize(load(name))
    model.validate(record)
    assert record["source"] == "osv"
    assert record["sourceId"] == load(name)["id"]


def test_ids_aliases_and_dates_are_preserved():
    raw = load("ecosystem_pysec")
    record = normalize(raw)
    assert record["aliases"] == raw["aliases"]
    assert record["modifiedAt"] == raw["modified"]
    assert record["publishedAt"] == raw["published"]


def test_range_events_keep_their_order_and_types():
    raw = load("semver_fixed")
    record = normalize(raw)
    got = [(r["type"], e["type"], e["version"]) for a in record["affected"] for r in a["ranges"] for e in r["events"]]
    want = [
        (r["type"], k, v)
        for a in raw["affected"]
        for r in a.get("ranges", [])
        if r["type"] != "GIT"
        for e in r["events"]
        for k, v in e.items()
    ]
    assert got == want and got


def test_severity_score_becomes_vector():
    raw = load("semver_fixed")
    record = normalize(raw)
    assert record["severity"] == [{"type": s["type"], "vector": s["score"]} for s in raw["severity"]]


def test_versions_only_entries_keep_their_versions():
    record = normalize(load("versions_only"))
    assert any(a["versions"] and not a["ranges"] for a in record["affected"])


def test_git_ranges_are_dropped():
    raw = load("git")
    assert any(r["type"] == "GIT" for a in raw["affected"] for r in a["ranges"])
    record = normalize(raw)
    assert all(r["type"] != "GIT" for a in record["affected"] for r in a["ranges"])


def test_withdrawn_is_kept():
    assert normalize(load("withdrawn"))["withdrawnAt"] == load("withdrawn")["withdrawn"]


def test_affected_without_a_package_is_dropped():
    raw = load("ecosystem_pysec")
    raw["affected"].append({"ranges": [{"type": "GIT", "repo": "https://x", "events": [{"introduced": "0"}]}]})
    assert len(normalize(raw)["affected"]) == len(load("ecosystem_pysec")["affected"])


def test_unknown_range_type_is_refused():
    raw = load("ecosystem_pysec")
    raw["affected"][0]["ranges"][0]["type"] = "HG"
    with pytest.raises(NormalizeError, match="range type"):
        normalize(raw)


def test_unknown_event_is_refused():
    raw = load("ecosystem_pysec")
    raw["affected"][0]["ranges"][0]["events"].append({"limit": "9"})
    with pytest.raises(NormalizeError, match="range event"):
        normalize(raw)


@pytest.mark.parametrize("field", ["id", "modified"])
def test_missing_required_field_fails_validation(field):
    raw = load("ecosystem_pysec")
    del raw[field]
    with pytest.raises(InvalidEvent):
        model.validate(normalize(raw))


def test_bad_date_fails_validation():
    raw = load("ecosystem_pysec")
    raw["modified"] = "last tuesday"
    with pytest.raises(InvalidEvent):
        model.validate(normalize(raw))


def test_range_without_events_fails_validation():
    raw = load("ecosystem_pysec")
    raw["affected"][0]["ranges"][0]["events"] = []
    with pytest.raises(InvalidEvent):
        model.validate(normalize(raw))


def test_non_object_is_refused():
    with pytest.raises(NormalizeError):
        normalize([])  # type: ignore[arg-type]
