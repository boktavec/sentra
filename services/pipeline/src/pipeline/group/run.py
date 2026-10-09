"""One grouper pass as sentra_grouper: take advisories changed since the watermark, recompute the whole
component around each (plus the groups they used to be in, so splits are seen), and write the result.
Idempotent: the output is a function of the advisory rows, so a crash or a rerun converges.
ponytail: a changed component can be recomputed twice in one pass when its members span batches, and an
alias shared by thousands of advisories is loaded whole. Neither is measured yet (see the SENTRA-12 spec)."""

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import psycopg

from . import metrics
from .components import Advisory, Group, build_groups

log = logging.getLogger("pipeline")

WATERMARK = "advisory_watermark"
LOCK = "hashtext('sentra_grouper')"
SEP = "\x1f"
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
NIL = "00000000-0000-0000-0000-000000000000"


@dataclass
class Stats:
    advisories: int = 0
    groups: int = 0
    merged: int = 0
    conflicts: int = 0


def _fetch(conn: psycopg.Connection, ids: set[str]) -> list[Advisory]:
    rows = conn.execute(
        "SELECT v.id::text, v.source, v.source_id, v.aliases, "
        "COALESCE(array_agg(DISTINCT a.ecosystem || chr(31) || a.match_name) FILTER (WHERE a.id IS NOT NULL), '{}') "
        "FROM vulnerabilities v LEFT JOIN vulnerability_affected a ON a.vulnerability_id = v.id "
        "WHERE v.id = ANY(%s::uuid[]) GROUP BY v.id",
        (list(ids),),
    ).fetchall()
    return [
        Advisory(i, s, sid, tuple(al), frozenset(tuple(p.split(SEP, 1)) for p in pk))  # type: ignore[misc]
        for i, s, sid, al, pk in rows
    ]


def _component_closure(conn: psycopg.Connection, seeds: set[str]) -> dict[str, Advisory]:
    """Every advisory reachable from `seeds` through shared identifiers or a shared previous group."""
    loaded: dict[str, Advisory] = {}
    frontier = set(seeds)
    while frontier:
        fresh = _fetch(conn, frontier)
        loaded.update((a.id, a) for a in fresh)
        idents = sorted({i for a in fresh for i in a.identifiers})
        found = conn.execute(
            "SELECT id::text FROM vulnerabilities WHERE source_id = ANY(%s) OR aliases && %s "
            "UNION SELECT m.vulnerability_id::text FROM vulnerability_group_members m WHERE m.group_id IN "
            "(SELECT group_id FROM vulnerability_group_members WHERE vulnerability_id = ANY(%s::uuid[]))",
            (idents, idents, [a.id for a in fresh]),
        ).fetchall()
        frontier = {r[0] for r in found} - loaded.keys()
    return loaded


def _write(conn: psycopg.Connection, loaded: dict[str, Advisory], groups: list[Group], stats: Stats) -> None:
    ids = list(loaded)
    old = {
        r[0]
        for r in conn.execute(
            "SELECT DISTINCT group_id::text FROM vulnerability_group_members WHERE vulnerability_id = ANY(%s::uuid[])",
            (ids,),
        )
    }
    new_ids = {g.id for g in groups}
    with conn.transaction(), conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO vulnerability_groups (id, canonical_vulnerability_id) VALUES (%s, %s) "
            "ON CONFLICT (id) DO UPDATE SET canonical_vulnerability_id = EXCLUDED.canonical_vulnerability_id, "
            "merged_into = NULL, updated_at = now() WHERE (vulnerability_groups.canonical_vulnerability_id, "
            "vulnerability_groups.merged_into) IS DISTINCT FROM (EXCLUDED.canonical_vulnerability_id, NULL)",
            [(g.id, g.canonical) for g in groups],
        )
        cur.executemany(
            "INSERT INTO vulnerability_group_members (vulnerability_id, group_id) VALUES (%s, %s) "
            "ON CONFLICT (vulnerability_id) DO UPDATE SET group_id = EXCLUDED.group_id, updated_at = now() "
            "WHERE vulnerability_group_members.group_id IS DISTINCT FROM EXCLUDED.group_id",
            [(m, g.id) for g in groups for m in g.members],
        )
        conflicted = [g for g in groups if g.conflict]
        cur.execute(
            "DELETE FROM group_conflicts WHERE vulnerability_id = ANY(%s::uuid[]) "
            "AND NOT vulnerability_id = ANY(%s::uuid[])",
            (ids, [g.canonical for g in conflicted]),
        )
        cur.executemany(
            "INSERT INTO group_conflicts (vulnerability_id, reason, component_size) VALUES (%s, %s, %s) "
            "ON CONFLICT (vulnerability_id) DO UPDATE SET reason = EXCLUDED.reason, "
            "component_size = EXCLUDED.component_size",
            [(g.canonical, g.conflict, g.component_size) for g in conflicted],
        )
        stale = old - new_ids
        if stale:
            cur.execute(
                "UPDATE vulnerability_groups g SET merged_into = m.group_id, updated_at = now() "
                "FROM vulnerability_group_members m WHERE g.id = ANY(%s::uuid[]) "
                "AND m.vulnerability_id = g.canonical_vulnerability_id AND g.merged_into IS DISTINCT FROM m.group_id",
                (list(stale),),
            )
    stats.advisories += len(ids)
    stats.groups += len(groups)
    stats.merged += len(stale)
    stats.conflicts += len(conflicted)


def run_once(conn: psycopg.Connection, batch: int = 500, overlap_seconds: int = 300) -> Stats | None:
    """None when another grouper holds the lock. `conn` must be autocommit."""
    if not conn.execute(f"SELECT pg_try_advisory_lock({LOCK})").fetchone()[0]:  # type: ignore[index]
        return None
    run_id = conn.execute("INSERT INTO group_runs DEFAULT VALUES RETURNING id").fetchone()[0]  # type: ignore[index]
    stats, t0 = Stats(), time.monotonic()
    try:
        high = conn.execute("SELECT max(updated_at) FROM vulnerabilities").fetchone()[0]  # type: ignore[index]
        if high is not None:
            wm = conn.execute("SELECT watermark FROM group_state WHERE name = %s", (WATERMARK,)).fetchone()
            cursor = wm[0] - timedelta(seconds=overlap_seconds) if wm and wm[0] else EPOCH
            last_id = NIL
            while True:
                rows = conn.execute(
                    "SELECT id::text, updated_at FROM vulnerabilities WHERE (updated_at, id) > (%s, %s::uuid) "
                    "AND updated_at <= %s ORDER BY updated_at, id LIMIT %s",
                    (cursor, last_id, high, batch),
                ).fetchall()
                if not rows:
                    break
                loaded = _component_closure(conn, {r[0] for r in rows})
                _write(conn, loaded, build_groups(loaded.values()), stats)
                last_id, cursor = rows[-1]
            conn.execute(
                "INSERT INTO group_state (name, watermark) VALUES (%s, %s) "
                "ON CONFLICT (name) DO UPDATE SET watermark = EXCLUDED.watermark, updated_at = now()",
                (WATERMARK, high),
            )
        conn.execute(
            "UPDATE group_runs SET finished_at = now(), advisories = %s, groups = %s, merged = %s, conflicts = %s "
            "WHERE id = %s",
            (stats.advisories, stats.groups, stats.merged, stats.conflicts, run_id),
        )
    except Exception as exc:
        conn.execute("UPDATE group_runs SET finished_at = now(), error = %s WHERE id = %s", (str(exc)[:500], run_id))
        raise
    finally:
        conn.execute(f"SELECT pg_advisory_unlock({LOCK})")
    metrics.record(stats, time.monotonic() - t0)
    log.info(
        "group run finished",
        extra={
            "outcome": f"advisories={stats.advisories} groups={stats.groups} merged={stats.merged} "
            f"conflicts={stats.conflicts}"
        },
    )
    return stats
