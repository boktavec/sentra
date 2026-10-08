"""Time matching at the SENTRA-13 lab-scale target on a scratch database (never touches real data).

Loads real advisories from OSV `all.zip` dumps (PyPI, npm), adds synthetic tenants (default 100 orgs, 1,000
projects, 1,500 dependencies each, about 10% of them packages that have advisories), then times:
  forward   reconcile one project, first time
  rerun     the same project again (no writes expected)
  first     reverse run with no watermark (every project)
  steady    one advisory changes
  sweep     a full sweep
Usage: uv run python bench/correlate_bench.py --pypi PyPI.zip --npm npm.zip [--projects 1000] [--deps 1500]
"""

import argparse
import json
import random
import re
import statistics
import sys
import time
import uuid
import zipfile
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pipeline.correlate.config import Limits  # noqa: E402
from pipeline.correlate.process import Deps, handle_normalized  # noqa: E402
from pipeline.correlate.store import Store  # noqa: E402
from pipeline.correlate.sweep import Sweep  # noqa: E402
from pipeline.normalize.adapters.osv import normalize  # noqa: E402
from pipeline.normalize.events import vulnerabilities_normalized  # noqa: E402

MIGRATIONS = Path(__file__).resolve().parents[3] / "apps" / "api" / "migrations"
ADMIN = "postgresql://sentra:sentra@localhost:5440/sentra"
PASSWORD = "bench-pw"


def load_advisories(conn: psycopg.Connection, dumps: list[tuple[str, str]]) -> dict[str, dict[str, list[str]]]:
    """Real advisories into the vulnerability tables. Returns {ecosystem: {package: [range boundary versions]}}.

    One COPY at a time per connection, parents before children, so the foreign keys hold."""
    boundaries: dict[str, dict[str, list[str]]] = {}
    vulns: list[tuple] = []
    affected: list[tuple] = []
    ranges: list[tuple] = []
    seen: set[str] = set()  # 47 advisories appear in both dumps
    for path, eco in dumps:
        with zipfile.ZipFile(path) as z:
            for name in z.namelist():
                rec = normalize(json.loads(z.read(name)))
                if rec["sourceId"] in seen:
                    continue
                seen.add(rec["sourceId"])
                vid = uuid.uuid4()
                vulns.append((vid, "osv", rec["sourceId"], rec["modifiedAt"], rec["withdrawnAt"], "a" * 64, name, 1, 1))
                for e in rec["affected"]:
                    aid = uuid.uuid4()
                    affected.append((aid, vid, e["ecosystem"], e["packageName"], e["versions"]))
                    for i, rg in enumerate(e["ranges"]):
                        for j, ev in enumerate(rg["events"]):
                            ranges.append((aid, i, j, rg["type"], ev["type"], ev["version"]))
                            if ev["version"] != "0" and e["ecosystem"] == eco:
                                boundaries.setdefault(eco, {}).setdefault(e["packageName"], []).append(ev["version"])
    copies = (
        (
            "vulnerabilities (id, source, source_id, modified_at, withdrawn_at, source_artifact_sha256, "
            "source_entry, schema_version, adapter_version)",
            vulns,
        ),
        ("vulnerability_affected (id, vulnerability_id, ecosystem, package_name, versions)", affected),
        (
            "vulnerability_ranges (affected_id, range_index, event_index, range_type, event_type, event_version)",
            ranges,
        ),
    )
    for table, rows in copies:
        with conn.cursor() as cur, cur.copy(f"COPY {table} FROM STDIN") as copy:  # noqa: S608
            for row in rows:
                copy.write_row(row)
    return boundaries


def load_tenants(
    conn: psycopg.Connection, boundaries, orgs: int, projects: int, deps: int, share: float, dense: bool = False
) -> list[str]:
    rng = random.Random(13)
    user = conn.execute("INSERT INTO users (issuer, subject) VALUES ('b', 'b') RETURNING id").fetchone()[0]  # type: ignore[index]
    org_ids = [
        conn.execute(
            "INSERT INTO organizations (name, slug, created_by) VALUES (%s, %s, %s) RETURNING id",
            (f"org {i}", f"org-{i:04d}", user),
        ).fetchone()[0]  # type: ignore[index]
        for i in range(orgs)
    ]
    names = {eco: sorted(pkgs) for eco, pkgs in boundaries.items()}
    # `dense` weights the choice by how many range boundaries a package has, which favours packages with
    # hundreds of advisories and gives thousands of findings per project: a stress case, not a typical one.
    weighted = {eco: [(n, v) for n, vs in pkgs.items() for v in vs] for eco, pkgs in boundaries.items()}
    # Projects and imports first: a COPY holds the connection, so nothing else may run while it streams.
    tenants = []
    for p in range(projects):
        org = org_ids[p % orgs]
        pid = conn.execute(
            "INSERT INTO projects (org_id, name, slug, created_by) VALUES (%s, %s, %s, %s) RETURNING id",
            (org, f"project {p}", f"proj-{p:05d}", user),
        ).fetchone()[0]  # type: ignore[index]
        imp = conn.execute(
            "INSERT INTO sbom_imports (org_id, project_id, created_by, filename, status, object_key, expires_at, "
            "dependency_count, skipped_count) "
            "VALUES (%s, %s, %s, 'b.json', 'parsed', %s, now(), %s, 0) RETURNING id",
            (org, pid, user, f"k-{uuid.uuid4()}", deps),
        ).fetchone()[0]  # type: ignore[index]
        tenants.append((p, org, pid, imp))
    with (
        conn.cursor() as d,
        d.copy(
            "COPY sbom_dependencies (import_id, org_id, project_id, purl, purl_type, namespace, name, version, "
            "ecosystem, scope, occurrences) FROM STDIN"
        ) as cd,
    ):
        for p, org, pid, imp in tenants:
            eco = "PyPI" if p % 2 else "npm"
            seen: set[str] = set()  # one row per purl per import
            for i in range(deps):
                if rng.random() < share and boundaries.get(eco):
                    if dense:
                        name, version = rng.choice(weighted[eco])
                    else:
                        name = rng.choice(names[eco])  # uniform over packages, not weighted by advisory count
                        version = rng.choice(boundaries[eco][name])
                else:
                    name, version = (
                        f"pkg-{rng.randrange(10**6)}-{i}",
                        f"{rng.randrange(9)}.{rng.randrange(20)}.{rng.randrange(20)}",
                    )
                if eco == "npm" and name.startswith("@") and "/" in name:
                    ns, _, base = name.partition("/")
                    purl = f"pkg:npm/{ns.replace('@', '%40')}/{base}@{version}"
                    if purl in seen:
                        continue
                    seen.add(purl)
                    cd.write_row((imp, org, pid, purl, "npm", ns, base, version, eco, "required", 1))
                else:
                    purl = f"pkg:{eco.lower()}/{re.sub('[^a-z0-9._-]', '-', name.lower())}@{version}"
                    if purl in seen:
                        continue
                    seen.add(purl)
                    cd.write_row((imp, org, pid, purl, eco.lower(), None, name, version, eco, "required", 1))
    return [str(t[2]) for t in tenants]


def timed(label: str, fn):
    t = time.perf_counter()
    out = fn()
    print(f"{label:<28}{time.perf_counter() - t:9.2f} s")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pypi", required=True)
    ap.add_argument("--npm", required=True)
    ap.add_argument("--orgs", type=int, default=100)
    ap.add_argument("--projects", type=int, default=1000)
    ap.add_argument("--deps", type=int, default=1500)
    ap.add_argument("--share", type=float, default=0.10, help="share of dependencies that have advisories")
    ap.add_argument("--dense", action="store_true", help="stress case: weight packages by advisory count")
    args = ap.parse_args()

    name = f"correlate_bench_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(ADMIN, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(ADMIN, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            for f in sorted(MIGRATIONS.glob("*.sql")):
                conn.execute(f.read_text())  # type: ignore[arg-type]
            conn.execute(sql.SQL("ALTER ROLE sentra_correlator LOGIN PASSWORD {}").format(sql.Literal(PASSWORD)))
            boundaries = timed(
                "load advisories", lambda: load_advisories(conn, [(args.pypi, "PyPI"), (args.npm, "npm")])
            )
            projects = timed(
                "load tenants",
                lambda: load_tenants(conn, boundaries, args.orgs, args.projects, args.deps, args.share, args.dense),
            )
            conn.execute("ANALYZE")
            counts = conn.execute(
                "SELECT (SELECT count(*) FROM vulnerabilities), (SELECT count(*) FROM vulnerability_affected), "
                "(SELECT count(*) FROM sbom_dependencies)"
            ).fetchone()
            print(f"advisories {counts[0]:,}  affected entries {counts[1]:,}  dependencies {counts[2]:,}")  # type: ignore[index]

        store = Store(make_conninfo(url, user="sentra_correlator", password=PASSWORD))
        deps = Deps(store=store, limits=Limits(sweep_batch=50))
        first = [timed("forward, 1 project (cold)", lambda: store.reconcile(projects[0]))]
        again = []
        for p in projects[1:6]:
            t = time.perf_counter()
            r = store.reconcile(p)
            again.append(time.perf_counter() - t)
            first.append(r)
        print(
            f"forward, 5 more projects     median {statistics.median(again):.3f} s  findings in first project: "
            f"{first[0].created}"
        )  # type: ignore[attr-defined]
        timed("re-run, same project", lambda: store.reconcile(projects[0]))
        again_r = store.reconcile(projects[0])
        print(
            f"  re-run wrote: created={again_r.created} updated={again_r.updated} "
            f"resolved={again_r.resolved} unchanged={again_r.unchanged}"
        )
        timed(
            "first reverse run (all)",
            lambda: handle_normalized(
                vulnerabilities_normalized(str(uuid.uuid4()), "bench", "osv", "PyPI", "a" * 64, 1, 1, 0, 0), deps
            ),
        )
        with psycopg.connect(url, autocommit=True) as conn:
            total = conn.execute(
                "SELECT count(*), count(*) FILTER (WHERE match_quality = 'unverifiable') FROM findings"
            ).fetchone()
            # The bulk load stamped every advisory just now, inside the watermark overlap; age them so only
            # the one advisory changed below counts as new.
            conn.execute("UPDATE vulnerabilities SET updated_at = now() - interval '1 hour'")
            conn.execute(
                "UPDATE vulnerabilities SET updated_at = now() WHERE id = (SELECT id FROM vulnerabilities LIMIT 1)"
            )
        print(f"findings {total[0]:,} (unverifiable {total[1]:,})")  # type: ignore[index]
        high = store.advisory_high_water() or store.now()
        affected = store.projects_affected_by(store.watermark(), high, deps.limits.watermark_overlap_seconds)
        print(f"  that advisory touches {len(affected)} of {len(projects)} projects")
        timed(
            "  affected-projects query",
            lambda: store.projects_affected_by(store.watermark(), high, deps.limits.watermark_overlap_seconds),
        )
        timed("  reconcile those projects", lambda: [store.reconcile(p) for p in affected])
        timed(
            "steady: one advisory changes",
            lambda: handle_normalized(
                vulnerabilities_normalized(str(uuid.uuid4()), "bench", "osv", "PyPI", "a" * 64, 1, 1, 0, 0), deps
            ),
        )
        sweep = Sweep(deps)

        def full_sweep() -> None:
            sweep.maybe_start(0)
            while sweep.step():
                pass

        timed("full sweep (all projects)", full_sweep)
        store.close()
    finally:
        with psycopg.connect(ADMIN, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


if __name__ == "__main__":
    main()
