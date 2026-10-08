"""Decide whether one dependency version is affected by one advisory `affected` entry (OSV semantics).

Pure functions: no database, no clock. The result is a Decision, or None when the entry does not
affect the version. A version we cannot judge is `unverifiable` with a reason, never a guess.
"""

from dataclasses import dataclass
from typing import Any

from .versions import COMPARATORS, Unparseable, comparator_name

# Unverifiable reasons, most useful first: when several apply, the first one is reported.
REASONS = ("version_unparseable", "range_malformed", "ecosystem_unsupported", "no_version_data")
_RANK = {"introduced": 0, "last_affected": 1, "fixed": 2}


class Malformed(ValueError):
    pass


@dataclass(frozen=True)
class Decision:
    quality: str  # confirmed | unverifiable
    reason: str | None
    evidence: dict[str, Any]


def _in_range(parse: Any, key: Any, events: list[dict[str, str]]) -> bool:
    """OSV's walk: sort the events by version, then `introduced` switches affected on, `fixed` and
    `last_affected` switch it off. Version "0" means "from the beginning" and sorts first."""
    if not any(e["type"] == "introduced" for e in events):
        raise Malformed("range has no introduced event")
    ordered = []
    for e in events:
        try:
            at = None if e["version"] == "0" else parse(e["version"])
        except Unparseable as err:
            raise Malformed(str(err)) from err
        ordered.append((at, e["type"]))
    ordered.sort(key=lambda o: ((0,) if o[0] is None else (1, o[0]), _RANK[o[1]]))
    affected = False
    for at, kind in ordered:
        if kind == "introduced":
            affected = affected or at is None or key >= at
        elif kind == "fixed":
            affected = affected and not (at is None or key >= at)
        else:
            affected = affected and not (at is None or key > at)
    return affected


def _same(ecosystem: str, a: str, b: str) -> bool:
    """Equal as strings, or equal under the ecosystem's ordering when both parse (PyPI `1.0` is `1.0.0`)."""
    if a == b:
        return True
    name = comparator_name("ECOSYSTEM", ecosystem)
    if name is None:
        return False
    try:
        return COMPARATORS[name](a) == COMPARATORS[name](b)
    except Unparseable:
        return False


def decide(
    ecosystem: str, package: str, version: str, versions: list[str], ranges: list[dict[str, Any]]
) -> Decision | None:
    base = {"package": package, "dependencyVersion": version}
    if any(_same(ecosystem, version, v) for v in versions):
        return Decision("confirmed", None, {**base, "rule": "explicit_version", "comparator": None})
    unverifiable: dict[str, dict[str, Any]] = {}
    for r in ranges:
        name = comparator_name(r["type"], ecosystem)
        evidence = {**base, "rule": "range", "comparator": name, "range": r}
        if name is None:
            unverifiable.setdefault("ecosystem_unsupported", evidence)
            continue
        parse = COMPARATORS[name]
        try:
            key = parse(version)
        except Unparseable:
            unverifiable.setdefault("version_unparseable", evidence)
            continue
        try:
            if _in_range(parse, key, r["events"]):
                return Decision("confirmed", None, evidence)
        except Malformed:
            unverifiable.setdefault("range_malformed", evidence)
    if not versions and not ranges:
        unverifiable["no_version_data"] = {**base, "rule": "no_version_data", "comparator": None}
    for reason in REASONS:
        if reason in unverifiable:
            return Decision("unverifiable", reason, unverifiable[reason])
    return None
