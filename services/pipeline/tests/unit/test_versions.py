import pytest

from pipeline.correlate.versions import Unparseable, comparator_name, pep440, semver


@pytest.mark.parametrize(
    ("lower", "higher"),
    [
        ("1.0.0-alpha", "1.0.0-alpha.1"),
        ("1.0.0-alpha.1", "1.0.0-alpha.beta"),
        ("1.0.0-alpha.beta", "1.0.0-beta"),
        ("1.0.0-beta.2", "1.0.0-beta.11"),  # numeric identifiers compare as numbers
        ("1.0.0-rc.1", "1.0.0"),
        ("1.9.0", "1.10.0"),
        ("1.2.3", "2.0.0"),
    ],
)
def test_semver_follows_the_spec_precedence_examples(lower: str, higher: str):
    assert semver(lower) < semver(higher)


def test_semver_ignores_build_metadata():
    assert semver("1.0.0+build.1") == semver("1.0.0+build.2") == semver("1.0.0")


@pytest.mark.parametrize("bad", ["", "1.0", "1", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3-01x?", "latest", "1.x"])
def test_semver_rejects_what_is_not_a_semantic_version(bad: str):
    with pytest.raises(Unparseable):
        semver(bad)


@pytest.mark.parametrize(
    ("lower", "higher"),
    [("1.0rc1", "1.0"), ("1.0.dev1", "1.0a1"), ("1.0", "1.0.post1"), ("0.9", "0.10"), ("1.0", "1!0.1")],
)
def test_pep440_orders_pre_post_dev_and_epochs(lower: str, higher: str):
    assert pep440(lower) < pep440(higher)


def test_pep440_treats_trailing_zeros_as_equal():
    assert pep440("1.0") == pep440("1.0.0")


@pytest.mark.parametrize("bad", ["", "latest", "1.x", "not a version"])
def test_pep440_rejects_what_is_not_pep440(bad: str):
    with pytest.raises(Unparseable):
        pep440(bad)


def test_comparators_by_range_type_and_ecosystem():
    assert comparator_name("SEMVER", "PyPI") == "semver"  # SEMVER wins over the ecosystem's own order
    assert comparator_name("ECOSYSTEM", "PyPI") == "pep440"
    assert comparator_name("ECOSYSTEM", "npm") == "semver"
    assert comparator_name("ECOSYSTEM", "Maven") is None
