from dataclasses import dataclass
from typing import Any

from packageurl import PackageURL

# purl type -> OSV ecosystem name. Types not listed (deb, apk, rpm, docker, ...) are stored with a
# NULL ecosystem: kept, but not matchable until someone maps them.
OSV_ECOSYSTEMS = {
    "npm": "npm",
    "pypi": "PyPI",
    "maven": "Maven",
    "golang": "Go",
    "cargo": "crates.io",
    "nuget": "NuGet",
    "gem": "RubyGems",
    "composer": "Packagist",
    "hex": "Hex",
    "pub": "Pub",
}

# Most required first: when one package appears under several scopes, the strictest one wins.
SCOPE_RANK = {"required": 0, "optional": 1, "excluded": 2}


class TooManyComponents(Exception):
    pass


@dataclass
class Dependency:
    purl: str
    purl_type: str
    namespace: str | None
    name: str
    version: str
    ecosystem: str | None
    scope: str
    occurrences: int = 1


@dataclass(frozen=True)
class Parsed:
    dependencies: list[Dependency]  # sorted by purl, so the same file always yields the same rows
    skipped: int  # components with no usable purl


def _dependency(component: dict[str, Any]) -> Dependency | None:
    raw = component.get("purl")
    if not isinstance(raw, str):
        return None
    try:
        purl = PackageURL.from_string(raw)
    except ValueError:
        return None
    # No version means nothing to match against a vulnerability's affected range.
    if not purl.version:
        return None
    scope = component.get("scope")
    return Dependency(
        purl=purl.to_string(),
        purl_type=purl.type,
        namespace=purl.namespace,
        name=purl.name,
        version=purl.version,
        ecosystem=OSV_ECOSYSTEMS.get(purl.type),
        scope=scope if scope in SCOPE_RANK else "required",  # the CycloneDX default
    )


def parse(doc: dict[str, Any], max_components: int) -> Parsed:
    """Extract one Dependency per canonical purl from a CycloneDX document, nested components included.

    Raises TooManyComponents when the document holds more than `max_components` components.
    """
    found: dict[str, Dependency] = {}
    skipped = seen = 0
    pending = [c for c in doc.get("components") or [] if isinstance(c, dict)]
    while pending:  # a stack rather than recursion: the file controls how deep it nests
        component = pending.pop()
        seen += 1
        if seen > max_components:
            raise TooManyComponents
        pending.extend(c for c in component.get("components") or [] if isinstance(c, dict))
        dep = _dependency(component)
        if dep is None:
            skipped += 1
            continue
        known = found.get(dep.purl)
        if known is None:
            found[dep.purl] = dep
            continue
        known.occurrences += 1
        if SCOPE_RANK[dep.scope] < SCOPE_RANK[known.scope]:
            known.scope = dep.scope
    return Parsed(sorted(found.values(), key=lambda d: d.purl), skipped)
