"""reconcile(project): make the project's findings equal what its latest parsed import and the current
advisories say (ADR 0003). One transaction per project, serialized by a Postgres advisory lock, so
concurrent triggers and workers cannot undo each other and re-running changes nothing."""

import json
import time
from dataclasses import dataclass, field
from typing import Any

import psycopg
from packageurl import PackageURL
from psycopg.types.json import Jsonb

from .match import Decision, decide

MATCHER_VERSION = 1

_CANDIDATES = """
SELECT d.purl, d.version, d.ecosystem, d.scope, a.id, a.vulnerability_id, a.package_name, a.versions
FROM sbom_dependencies d
JOIN vulnerability_affected a ON a.ecosystem = d.ecosystem AND a.match_name = d.match_name
JOIN vulnerabilities v ON v.id = a.vulnerability_id
WHERE d.import_id = %s AND v.withdrawn_at IS NULL
"""
_RANGES = """
SELECT affected_id, range_index, range_type, event_type, event_version
FROM vulnerability_ranges WHERE affected_id = ANY(%s::uuid[])
ORDER BY affected_id, range_index, event_index
"""


@dataclass
class Result:
    created: int = 0
    updated: int = 0
    reopened: int = 0
    resolved: int = 0
    unchanged: int = 0
    unmatchable: int = 0  # dependencies in the latest import with no ecosystem mapping
    lock_wait: float = 0.0  # seconds spent waiting for the project's advisory lock
    import_id: str | None = None
    # Decisions by (quality, reason) for the metrics; counts findings, not candidates.
    quality: dict[tuple[str, str | None], int] = field(default_factory=dict)


@dataclass
class _Present:
    """What the latest import holds: exact purls (they carry the version) and package identities."""

    purls: set[str] = field(default_factory=set)
    packages: set[tuple[str, str | None, str]] = field(default_factory=set)


@dataclass
class _Desired:
    vulnerability_id: str
    purl: str
    version: str
    ecosystem: str
    scope: str
    decision: Decision


def _ranges(conn: psycopg.Connection, affected_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, dict[int, dict[str, Any]]] = {}
    for affected_id, index, range_type, event_type, event_version in conn.execute(_RANGES, (affected_ids,)):
        r = out.setdefault(str(affected_id), {}).setdefault(index, {"type": range_type, "events": []})
        r["events"].append({"type": event_type, "version": event_version})
    return {k: [v[i] for i in sorted(v)] for k, v in out.items()}


def _rank(d: Decision, package: str) -> tuple[int, str, str]:
    """Confirmed first, then a stable order, so the entry that decides a finding never depends on row order."""
    return (0 if d.quality == "confirmed" else 1, package, json.dumps(d.evidence, sort_keys=True))


def _desired(conn: psycopg.Connection, import_id: str) -> dict[tuple[str, str], _Desired]:
    rows = conn.execute(_CANDIDATES, (import_id,)).fetchall()
    ranges = _ranges(conn, [str(r[4]) for r in rows]) if rows else {}
    best: dict[tuple[str, str], tuple[tuple[int, str, str], _Desired]] = {}
    for purl, version, ecosystem, scope, affected_id, vuln_id, package, versions in rows:
        decision = decide(ecosystem, package, version, versions, ranges.get(str(affected_id), []))
        if decision is None:
            continue
        key = (purl, str(vuln_id))
        rank = _rank(decision, package)
        if key not in best or rank < best[key][0]:
            best[key] = (rank, _Desired(str(vuln_id), purl, version, ecosystem, scope, decision))
    return {k: v[1] for k, v in best.items()}


def _package(purl: str) -> tuple[str, str | None, str]:
    p = PackageURL.from_string(purl)
    return (p.type, p.namespace, p.name)


def reconcile(conn: psycopg.Connection, project_id: str) -> Result:
    """Reconcile one project in its own transaction. `conn` must not already be inside one."""
    result = Result()
    with conn.transaction():
        waited = time.monotonic()
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"findings:{project_id}",))
        result.lock_wait = time.monotonic() - waited
        latest = conn.execute(
            "SELECT id, org_id FROM sbom_imports WHERE project_id = %s AND status = 'parsed' "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        import_id, org_id = (str(latest[0]), str(latest[1])) if latest else (None, None)
        result.import_id = import_id
        desired = _desired(conn, import_id) if import_id else {}
        present = _Present()
        if import_id:
            for purl, ecosystem in conn.execute(
                "SELECT purl, ecosystem FROM sbom_dependencies WHERE import_id = %s", (import_id,)
            ):
                present.purls.add(purl)
                present.packages.add(_package(purl))
                result.unmatchable += ecosystem is None
        for d in desired.values():
            k = (d.decision.quality, d.decision.reason)
            result.quality[k] = result.quality.get(k, 0) + 1
        existing = {
            (r[0], str(r[1])): r
            for r in conn.execute(
                "SELECT purl, vulnerability_id, status, version, scope, import_id, match_quality, match_reason, "
                "matcher_version, evidence, id FROM findings WHERE project_id = %s",
                (project_id,),
            )
        }
        withdrawn = {
            str(r[0])
            for r in conn.execute(
                "SELECT id FROM vulnerabilities WHERE id = ANY(%s::uuid[]) AND withdrawn_at IS NOT NULL",
                ([k[1] for k in existing if k not in desired],),
            )
        }
        _write(conn, project_id, org_id, import_id, desired, existing, withdrawn, present, result)
    return result


def _write(
    conn, project_id, org_id, import_id, desired, existing, withdrawn, present: _Present, result: Result
) -> None:
    inserts: list[tuple] = []
    updates: list[tuple] = []
    resolves: list[tuple] = []
    for key, d in desired.items():
        row = existing.get(key)
        evidence = Jsonb(d.decision.evidence)
        fields = (d.version, d.scope, import_id, d.decision.quality, d.decision.reason, MATCHER_VERSION)
        if row is None:
            inserts.append(
                (org_id, project_id, d.vulnerability_id, d.purl, d.version, d.ecosystem, d.scope, import_id)
                + (d.decision.quality, d.decision.reason, MATCHER_VERSION, evidence)
            )
            result.created += 1
            continue
        same = (
            row[2] == "open"
            and (row[3], row[4], str(row[5]), row[6], row[7], row[8]) == fields
            and row[9] == d.decision.evidence
        )
        if same:
            result.unchanged += 1
            continue
        updates.append((*fields, evidence, row[10]))
        if row[2] == "resolved":
            result.reopened += 1
        else:
            result.updated += 1
    for key, row in existing.items():
        if key not in desired and row[2] == "open":
            resolves.append((_resolved_reason(key, withdrawn, present), row[10]))
            result.resolved += 1
    # executemany runs in psycopg's pipeline mode: one round trip per batch, not per row.
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope, "
            "import_id, match_quality, match_reason, matcher_version, evidence) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            inserts,
        )
        cur.executemany(
            "UPDATE findings SET status = 'open', resolved_at = NULL, resolved_reason = NULL, version = %s, "
            "scope = %s, import_id = %s, match_quality = %s, match_reason = %s, matcher_version = %s, "
            "evidence = %s, last_seen_at = now(), updated_at = now() WHERE id = %s",
            updates,
        )
        cur.executemany(
            "UPDATE findings SET status = 'resolved', resolved_reason = %s, resolved_at = now(), updated_at = now() "
            "WHERE id = %s",
            resolves,
        )


def _resolved_reason(key: tuple[str, str], withdrawn: set[str], present: _Present) -> str:
    """Why an open finding is no longer true: its advisory was withdrawn, its package left the import or
    moved to another version, or the advisory still exists but no longer reaches this version."""
    if key[1] in withdrawn:
        return "advisory_withdrawn"
    if _package(key[0]) not in present.packages:
        return "dependency_removed"
    if key[0] not in present.purls:
        return "version_changed"
    return "advisory_updated"
