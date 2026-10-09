import itertools

from pipeline.group.components import Advisory, build_groups, group_id

PKG = frozenset({("PyPI", "django")})


def adv(source_id: str, *aliases: str, source: str = "osv", packages=PKG) -> Advisory:
    return Advisory(f"id-{source_id}", source, source_id, tuple(aliases), packages)


def test_advisories_sharing_a_cve_alias_become_one_group():
    ghsa = adv("GHSA-aaaa", "CVE-2024-1")
    pysec = adv("PYSEC-2024-1", "CVE-2024-1")
    (group,) = build_groups([ghsa, pysec])
    assert group.members == (ghsa.id, pysec.id)  # smallest key first
    assert group.canonical == ghsa.id
    assert group.id == group_id("osv", "GHSA-aaaa")
    assert group.conflict is None


def test_alias_pointing_at_a_held_advisory_links_them():
    (group,) = build_groups([adv("GHSA-aaaa", "CVE-2024-1"), adv("CVE-2024-1")])
    assert len(group.members) == 2


def test_unrelated_and_aliasless_advisories_are_singletons():
    groups = build_groups([adv("MAL-2024-1"), adv("MAL-2024-2")])
    assert [len(g.members) for g in groups] == [1, 1]
    assert all(g.conflict is None for g in groups)


def test_result_is_independent_of_input_order():
    advisories = [adv("GHSA-a", "CVE-1"), adv("PYSEC-1", "CVE-1"), adv("GHSA-b"), adv("OSV-1", "GHSA-b")]
    results = {tuple(build_groups(p)) for p in itertools.permutations(advisories)}
    assert len(results) == 1


def test_two_cves_in_one_component_are_not_merged():
    a, b = adv("GHSA-a", "CVE-1"), adv("GHSA-b", "CVE-2")
    bridge = adv("GHSA-c", "CVE-1", "CVE-2")
    groups = build_groups([a, b, bridge])
    assert len(groups) == 3
    assert {g.conflict for g in groups} == {"multiple_cves"}
    assert all(g.component_size == 3 and len(g.members) == 1 for g in groups)


def test_alias_bridging_different_packages_is_not_merged():
    groups = build_groups(
        [adv("GHSA-a", "X-1", packages=frozenset({("npm", "left-pad")})), adv("GHSA-b", "X-1", packages=PKG)]
    )
    assert len(groups) == 2
    assert {g.conflict for g in groups} == {"no_common_package"}


def test_advisory_without_package_data_does_not_veto():
    (group,) = build_groups([adv("GHSA-a", "X-1"), adv("GHSA-b", "X-1", packages=frozenset())])
    assert group.conflict is None and len(group.members) == 2


def test_group_id_is_stable():
    assert group_id("osv", "GHSA-aaaa") == group_id("osv", "GHSA-aaaa") != group_id("osv", "GHSA-aaab")


def test_package_less_kev_stub_joins_the_group_but_never_becomes_canonical():
    kev = adv("CVE-2024-1", source="cisa-kev", packages=frozenset())  # sorts before osv
    ghsa = adv("GHSA-aaaa", "CVE-2024-1")
    (group,) = build_groups([kev, ghsa])
    assert set(group.members) == {kev.id, ghsa.id}
    assert group.canonical == ghsa.id
    assert group.id == group_id("osv", "GHSA-aaaa")


def test_kev_stub_alone_is_its_own_group():
    (group,) = build_groups([adv("CVE-2024-1", source="cisa-kev", packages=frozenset())])
    assert group.canonical == "id-CVE-2024-1"
