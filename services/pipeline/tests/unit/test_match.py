import json
from pathlib import Path

import pytest

from pipeline.correlate.match import decide
from pipeline.normalize.adapters.osv import normalize

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "osv"


def rng(*events: tuple[str, str], type: str = "ECOSYSTEM") -> list[dict]:
    return [{"type": type, "events": [{"type": k, "version": v} for k, v in events]}]


def pypi(version: str, versions: list[str] | None = None, ranges: list[dict] | None = None):
    return decide("PyPI", "trac", version, versions or [], ranges or [])


def test_a_version_inside_an_introduced_fixed_range_is_confirmed_with_the_range_as_evidence():
    ranges = rng(("introduced", "0"), ("fixed", "0.10"))

    decision = pypi("0.9.5", ranges=ranges)

    assert decision and decision.quality == "confirmed" and decision.reason is None
    assert decision.evidence == {
        "package": "trac",
        "dependencyVersion": "0.9.5",
        "rule": "range",
        "comparator": "pep440",
        "range": ranges[0],
    }


@pytest.mark.parametrize("version", ["0.10", "0.10.1", "1.0"])
def test_the_fixed_version_and_later_are_not_affected(version: str):
    assert pypi(version, ranges=rng(("introduced", "0"), ("fixed", "0.10"))) is None


def test_a_version_below_introduced_is_not_affected():
    assert pypi("0.12.6", ranges=rng(("introduced", "0.12.7"), ("fixed", "0.12.18"))) is None


def test_last_affected_is_inclusive():
    ranges = rng(("introduced", "1.0"), ("last_affected", "1.4"))
    assert pypi("1.4", ranges=ranges)
    assert pypi("1.4.1", ranges=ranges) is None


def test_an_open_ended_range_affects_everything_after_introduced():
    assert pypi("99.0", ranges=rng(("introduced", "2.0")))


def test_several_intervals_in_one_range_and_unsorted_events():
    ranges = rng(("fixed", "2.5"), ("introduced", "2.0"), ("fixed", "1.5"), ("introduced", "1.0"))
    assert [bool(pypi(v, ranges=ranges)) for v in ("0.9", "1.2", "1.5", "2.2", "2.5")] == [
        False,
        True,
        False,
        True,
        False,
    ]


def test_the_explicit_versions_list_matches_by_the_ecosystem_ordering_not_just_spelling():
    assert pypi("144.0.0", versions=["144.0"]).evidence["rule"] == "explicit_version"  # type: ignore[union-attr]
    assert pypi("144.1", versions=["144.0"]) is None


def test_versions_and_ranges_are_combined():
    ranges = rng(("introduced", "1.0"), ("fixed", "1.1"))
    assert pypi("5.0", versions=["5.0"], ranges=ranges)
    assert pypi("1.0.5", versions=["5.0"], ranges=ranges)
    assert pypi("3.0", versions=["5.0"], ranges=ranges) is None


def test_a_semver_range_on_a_pypi_package_uses_semver_ordering():
    decision = pypi("1.0.0", ranges=rng(("introduced", "0"), ("fixed", "2.0.0"), type="SEMVER"))
    assert decision and decision.evidence["comparator"] == "semver"


def test_semver_prerelease_is_before_its_release():
    decision = decide("npm", "x", "2.0.0-rc.1", [], rng(("introduced", "0"), ("fixed", "2.0.0"), type="SEMVER"))
    assert decision and decision.quality == "confirmed"


def test_an_unparseable_dependency_version_is_unverifiable_not_guessed():
    decision = pypi("latest", ranges=rng(("introduced", "0"), ("fixed", "1.0")))
    assert decision and (decision.quality, decision.reason) == ("unverifiable", "version_unparseable")


def test_an_unparseable_version_inside_a_fixed_range_elsewhere_still_confirms():
    ranges = rng(("introduced", "0"), ("fixed", "1.0")) + rng(("introduced", "5.0"), type="SEMVER")
    decision = pypi("0.5", ranges=ranges)  # not valid semver (needs three parts) but valid PEP 440
    assert decision and decision.quality == "confirmed"


def test_an_unparseable_dependency_version_is_not_flagged_when_only_an_explicit_list_exists():
    assert pypi("latest", versions=["1.0"]) is None


@pytest.mark.parametrize(
    "ranges",
    [rng(("fixed", "1.0")), rng(("introduced", "1.0"), ("fixed", "banana"))],
    ids=["no-introduced", "bad-event-version"],
)
def test_a_range_that_cannot_be_evaluated_is_malformed(ranges: list[dict]):
    decision = pypi("1.0", ranges=ranges)
    assert decision and (decision.quality, decision.reason) == ("unverifiable", "range_malformed")


def test_an_ecosystem_range_without_a_comparator_is_unsupported():
    decision = decide("Maven", "g:a", "1.0", [], rng(("introduced", "0"), ("fixed", "2.0")))
    assert decision and (decision.quality, decision.reason) == ("unverifiable", "ecosystem_unsupported")


def test_an_entry_with_neither_versions_nor_ranges_is_no_version_data():
    decision = pypi("1.0")
    assert decision and (decision.quality, decision.reason) == ("unverifiable", "no_version_data")
    assert decision.evidence["rule"] == "no_version_data"


def test_confirmed_beats_unverifiable():
    ranges = rng(("fixed", "1.0")) + rng(("introduced", "0"), ("fixed", "2.0"))
    assert pypi("1.5", ranges=ranges).quality == "confirmed"  # type: ignore[union-attr]


def test_when_several_reasons_apply_the_most_useful_one_is_reported():
    # "1.0" is not valid semver (version_unparseable) and the first range is malformed.
    ranges = rng(("fixed", "1.0")) + rng(("introduced", "0"), ("fixed", "2.0"), type="SEMVER")
    decision = pypi("1.0", ranges=ranges)
    assert decision and decision.reason == "version_unparseable"


def affected(name: str) -> list[dict]:
    return normalize(json.loads((FIXTURES / f"{name}.json").read_text()))["affected"]


def test_real_pysec_advisory_trac_before_0_10():
    (entry,) = affected("ecosystem_pysec")
    args = (entry["ecosystem"], entry["packageName"])
    assert decide(*args, "0.9", entry["versions"], entry["ranges"])
    assert decide(*args, "0.9.99", entry["versions"], entry["ranges"])
    assert decide(*args, "0.10", entry["versions"], entry["ranges"]) is None


def test_real_ghsa_advisory_uv_range_and_listed_versions():
    entry = affected("semver_fixed")[0]
    args = (entry["ecosystem"], entry["packageName"])
    assert decide(*args, "0.12.10", entry["versions"], entry["ranges"])
    assert decide(*args, "0.12.18", entry["versions"], entry["ranges"]) is None
    assert decide(*args, "0.12.6", entry["versions"], entry["ranges"]) is None


def test_real_versions_only_advisory_has_no_range_to_evaluate():
    entry = affected("versions_only")[0]
    args = (entry["ecosystem"], entry["packageName"])
    assert decide(*args, "144.0", entry["versions"], entry["ranges"])
    assert decide(*args, "143.0", entry["versions"], entry["ranges"]) is None
