import pytest

from pipeline.parse import TooManyComponents, parse


def lib(purl: str | None, **over: object) -> dict:
    return {"type": "library", "name": "x", **({"purl": purl} if purl else {}), **over}


def test_purls_are_canonicalized_and_mapped_to_osv_ecosystems():
    result = parse(
        {"components": [lib("pkg:pypi/Requests@2.0"), lib("pkg:maven/org.x/lib@1"), lib("pkg:npm/%40s/a@1")]}, 100
    )

    assert [(d.purl, d.ecosystem, d.namespace, d.name) for d in result.dependencies] == [
        ("pkg:maven/org.x/lib@1", "Maven", "org.x", "lib"),
        ("pkg:npm/%40s/a@1", "npm", "@s", "a"),
        ("pkg:pypi/requests@2.0", "PyPI", None, "requests"),
    ]


def test_result_order_does_not_depend_on_input_order():
    a, b = lib("pkg:npm/a@1"), lib("pkg:npm/b@1")

    assert parse({"components": [a, b]}, 10) == parse({"components": [b, a]}, 10)


def test_nested_components_count_and_duplicates_merge_with_the_strictest_scope():
    doc = {"components": [lib("pkg:npm/a@1", scope="excluded", components=[lib("pkg:npm/a@1", scope="optional")])]}

    (dep,) = parse(doc, 10).dependencies

    assert (dep.occurrences, dep.scope) == (2, "optional")


def test_missing_scope_defaults_to_required():
    assert parse({"components": [lib("pkg:npm/a@1")]}, 10).dependencies[0].scope == "required"


@pytest.mark.parametrize("purl", [None, "", "junk", "pkg:npm/a", 7])
def test_components_without_a_usable_purl_are_skipped_and_counted(purl: object):
    result = parse({"components": [lib("pkg:npm/ok@1"), {"name": "x", "purl": purl}]}, 10)

    assert (len(result.dependencies), result.skipped) == (1, 1)


def test_malformed_shapes_do_not_crash():
    assert parse({"components": ["str", None, {"components": "nope"}]}, 10).skipped == 1
    assert parse({}, 10).dependencies == []


def test_the_component_cap_counts_nested_and_skipped_components():
    with pytest.raises(TooManyComponents):
        parse({"components": [lib(None, components=[lib(None), lib(None)])]}, 2)


def test_deep_nesting_does_not_recurse():
    component: dict = lib("pkg:npm/leaf@1")
    for _ in range(5000):
        component = lib(None, components=[component])

    assert len(parse({"components": [component]}, 10_000).dependencies) == 1
