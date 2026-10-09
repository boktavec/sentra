"""Pure grouping rule (SENTRA-12): advisories that share an identifier (their own id or an alias) are one
component. A component that looks like a bad alias chain is not merged; every member stays a singleton.
Deterministic: the result depends only on the advisories given, never on their order."""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass

# Fixed forever: group ids are uuid5(NAMESPACE, "source\0source_id") of the smallest member.
NAMESPACE = uuid.UUID("5e9a6a64-3d0b-4b9c-9a7e-12c0de5e17a1")


@dataclass(frozen=True)
class Advisory:
    id: str
    source: str
    source_id: str
    aliases: tuple[str, ...]
    packages: frozenset[tuple[str, str]]  # (ecosystem, match_name)

    @property
    def key(self) -> tuple[str, str]:
        return (self.source, self.source_id)

    @property
    def identifiers(self) -> set[str]:
        return {self.source_id, *self.aliases}


@dataclass(frozen=True)
class Group:
    id: str
    canonical: str  # advisory id of the smallest member
    members: tuple[str, ...]  # advisory ids
    conflict: str | None = None  # set on each singleton of a component that was refused
    component_size: int = 1


def group_id(source: str, source_id: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{source}\0{source_id}"))


def _ambiguity(members: list[Advisory]) -> str | None:
    cves = {i.upper() for m in members for i in m.identifiers if i.upper().startswith("CVE-")}
    if len(cves) > 1:
        return "multiple_cves"
    # Advisories that list no packages cannot be tested, so they do not veto.
    sets = [m.packages for m in members if m.packages]
    if sets and not frozenset.intersection(*sets):
        return "no_common_package"
    return None


def build_groups(advisories: Iterable[Advisory]) -> list[Group]:
    items = sorted(advisories, key=lambda a: a.key)
    parent = list(range(len(items)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    owner: dict[str, int] = {}
    for i, adv in enumerate(items):
        for ident in adv.identifiers:
            j = owner.setdefault(ident, i)
            parent[find(i)] = find(j)

    components: dict[int, list[Advisory]] = {}
    for i, adv in enumerate(items):
        components.setdefault(find(i), []).append(adv)

    groups: list[Group] = []
    for members in components.values():  # members stay sorted by key
        reason = _ambiguity(members) if len(members) > 1 else None
        if reason:
            groups += [
                Group(group_id(*m.key), m.id, (m.id,), conflict=reason, component_size=len(members)) for m in members
            ]
        else:
            first = members[0]
            groups.append(Group(group_id(*first.key), first.id, tuple(m.id for m in members), None, len(members)))
    return sorted(groups, key=lambda g: g.id)
