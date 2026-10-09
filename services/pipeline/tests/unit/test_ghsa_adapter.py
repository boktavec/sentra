import json
from pathlib import Path

import pytest

from pipeline.normalize import model
from pipeline.normalize.adapters.ghsa import NormalizeError, expand, normalize
from pipeline.normalize.archive import Entry
from pipeline.normalize.cvss_score import score

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "ghsa"
NAMES = ["npm_cvss3", "pip_range_osv_overlap", "withdrawn", "no_cve", "exact_version", "multi_range"]


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def advisory(**over) -> dict:
    return {**load("npm_cvss3"), **over}


def ranges(raw: dict) -> list[dict]:
    return [a["ranges"] for a in normalize(raw)["affected"]]


@pytest.mark.parametrize("name", NAMES)
def test_real_advisories_normalize_and_validate(name):
    raw = load(name)
    record = normalize(raw)
    model.validate(record)
    assert (record["source"], record["sourceId"]) == ("ghsa", raw["ghsa_id"])


def test_ids_dates_and_text_are_mapped():
    raw = load("npm_cvss3")
    record = normalize(raw)
    assert record["aliases"] == [raw["cve_id"]]  # the advisory's own GHSA id is not its own alias
    assert (record["publishedAt"], record["modifiedAt"]) == (raw["published_at"], raw["updated_at"])
    assert (record["summary"], record["details"]) == (raw["summary"], raw["description"])


def test_advisory_without_a_cve_has_no_aliases():
    assert normalize(load("no_cve"))["aliases"] == []


def test_withdrawn_is_kept_with_its_timestamp():
    raw = load("withdrawn")
    assert raw["withdrawn_at"]
    assert normalize(raw)["withdrawnAt"] == raw["withdrawn_at"]
    assert normalize(load("npm_cvss3"))["withdrawnAt"] is None


def test_github_ecosystem_names_become_osv_names():
    assert normalize(load("pip_range_osv_overlap"))["affected"][0]["ecosystem"] == "PyPI"
    assert normalize(load("multi_range"))["affected"][0]["ecosystem"] == "Maven"
    unknown = advisory(vulnerabilities=[{"package": {"ecosystem": "newthing", "name": "x"}}])
    assert normalize(unknown)["affected"][0]["ecosystem"] == "newthing"


def test_cvss_vector_is_kept_once_and_scores():
    raw = load("npm_cvss3")
    record = normalize(raw)
    v3, v4 = (raw["cvss_severities"][k]["vector_string"] for k in ("cvss_v3", "cvss_v4"))
    assert raw["cvss"]["vector_string"] == v3
    # The top-level `cvss` repeats the v3 vector, so it appears once.
    assert record["severity"] == [{"type": "CVSS_V3", "vector": v3}, {"type": "CVSS_V4", "vector": v4}]
    assert score(record["severity"])[1] == "4.0"


def test_advisory_without_any_cvss_has_no_severity():
    raw = advisory(cvss={"vector_string": None, "score": None}, cvss_severities=None)
    assert normalize(raw)["severity"] == []


def test_v4_vector_is_typed_by_its_prefix():
    v4 = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"
    raw = advisory(cvss_severities={"cvss_v3": {"vector_string": None}, "cvss_v4": {"vector_string": v4}}, cvss=None)
    assert normalize(raw)["severity"] == [{"type": "CVSS_V4", "vector": v4}]


def test_references_start_with_the_advisory_page_and_are_unique():
    raw = load("pip_range_osv_overlap")
    urls = [r["url"] for r in normalize(raw)["references"]]
    assert urls[0] == raw["html_url"] and len(urls) == len(set(urls))
    assert set(urls) == {raw["html_url"], *raw["references"]}


@pytest.mark.parametrize(
    ("expression", "want"),
    [
        ("<= 6.2.0", [{"type": "ECOSYSTEM", "events": [("introduced", "0"), ("last_affected", "6.2.0")]}]),
        ("< 1.4.2", [{"type": "ECOSYSTEM", "events": [("introduced", "0"), ("fixed", "1.4.2")]}]),
        (">= 1.0.0, < 1.4.2", [{"type": "ECOSYSTEM", "events": [("introduced", "1.0.0"), ("fixed", "1.4.2")]}]),
        (
            ">= 0.12.19, <= 0.12.20",
            [{"type": "ECOSYSTEM", "events": [("introduced", "0.12.19"), ("last_affected", "0.12.20")]}],
        ),
        (">= 2.0", [{"type": "ECOSYSTEM", "events": [("introduced", "2.0")]}]),
    ],
)
def test_version_range_becomes_events(expression, want):
    raw = advisory(
        vulnerabilities=[{"package": {"ecosystem": "npm", "name": "x"}, "vulnerable_version_range": expression}]
    )
    (got,) = ranges(raw)
    assert [{**r, "events": [(e["type"], e["version"]) for e in r["events"]]} for r in got] == want


def test_exact_version_is_a_listed_version_not_a_range():
    (entry,) = normalize(load("exact_version"))["affected"]
    assert entry["versions"] == ["3.9.0"] and entry["ranges"] == []


def test_each_vulnerability_entry_is_its_own_affected_entry():
    raw = load("multi_range")
    affected = normalize(raw)["affected"]
    assert len(affected) == len(raw["vulnerabilities"]) == 2
    assert [a["ranges"][0]["events"][0]["version"] for a in affected] == ["3.0.0", "4.15.0"]


def test_missing_range_or_package_is_handled():
    raw = advisory(
        vulnerabilities=[
            {"package": {"ecosystem": "npm", "name": "no-range"}, "vulnerable_version_range": None},
            {"package": None, "vulnerable_version_range": "< 1"},
        ]
    )
    (entry,) = normalize(raw)["affected"]
    assert entry["packageName"] == "no-range" and entry["versions"] == [] and entry["ranges"] == []


@pytest.mark.parametrize(
    "expression", ["> 1.0.0", "> 1.0.0, < 2.0.0", "~> 1.2", ">= 1, >= 2", "< 1, > 0, = 3", "garbage"]
)
def test_ranges_it_cannot_represent_are_quarantined_not_guessed(expression):
    raw = advisory(
        vulnerabilities=[{"package": {"ecosystem": "npm", "name": "x"}, "vulnerable_version_range": expression}]
    )
    with pytest.raises(NormalizeError):
        normalize(raw)


def test_non_object_record_is_rejected():
    with pytest.raises(NormalizeError):
        normalize([])  # type: ignore[arg-type]


def test_expand_yields_one_entry_per_advisory_named_for_provenance():
    page = [load("npm_cvss3"), load("withdrawn")]
    out = list(expand([Entry("page-00001.json", page), Entry("page-00002.json", [load("no_cve")])]))
    assert [e.name for e in out] == ["page-00001.json[0]", "page-00001.json[1]", "page-00002.json[0]"]
    assert out[1].record == page[1] and all(e.error is None for e in out)


def test_expand_turns_a_malformed_page_into_one_bad_entry():
    out = list(
        expand([Entry("page-00001.json", {"message": "oops"}), Entry("page-00002.json", None, "not valid JSON: x")])
    )
    assert [(e.name, e.record, bool(e.error)) for e in out] == [
        ("page-00001.json", None, True),
        ("page-00002.json", None, True),
    ]
