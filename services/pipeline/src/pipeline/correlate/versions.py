"""Version orderings for matching. A parser turns a version string into a sortable key or raises Unparseable;
the matcher never guesses at a version it cannot parse."""

import re
from collections.abc import Callable
from functools import lru_cache
from typing import Any

from packaging.version import InvalidVersion, Version


class Unparseable(ValueError):
    pass


# The same few thousand version strings are parsed again and again across candidates; a failed parse
# raises and is not cached, which is fine because unparseable versions are rare.
@lru_cache(maxsize=1 << 16)
def pep440(value: str) -> Any:
    try:
        return Version(value)
    except InvalidVersion as e:
        raise Unparseable(f"not a PEP 440 version: {value!r}") from e


_IDENT = r"[0-9A-Za-z-]+"
_SEMVER = re.compile(
    rf"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-({_IDENT}(?:\.{_IDENT})*))?(?:\+{_IDENT}(?:\.{_IDENT})*)?$"
)


@lru_cache(maxsize=1 << 16)
def semver(value: str) -> Any:
    """Semantic Versioning 2.0.0 precedence: build metadata is ignored and a release outranks its prereleases."""
    m = _SEMVER.match(value)
    if m is None:
        raise Unparseable(f"not a semantic version: {value!r}")
    major, minor, patch, pre = m.groups()
    if pre is None:
        return (int(major), int(minor), int(patch), 1, ())
    # Numeric identifiers rank below alphanumeric ones; a longer identifier list outranks its prefix.
    ids = tuple((0, int(i), "") if i.isdigit() else (1, 0, i) for i in pre.split("."))
    return (int(major), int(minor), int(patch), 0, ids)


COMPARATORS: dict[str, Callable[[str], Any]] = {"pep440": pep440, "semver": semver}

# OSV `ECOSYSTEM` ranges use the ecosystem's own ordering. Ecosystems missing here have no comparator yet,
# so their ranges are reported as unverifiable instead of compared by guesswork.
ECOSYSTEM_COMPARATORS = {"PyPI": "pep440", "npm": "semver"}


def comparator_name(range_type: str, ecosystem: str) -> str | None:
    """`SEMVER` ranges always use semver; `ECOSYSTEM` ranges use the ecosystem's ordering, if we have one."""
    return "semver" if range_type == "SEMVER" else ECOSYSTEM_COMPARATORS.get(ecosystem)
