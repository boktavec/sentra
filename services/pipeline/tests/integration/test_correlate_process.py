"""The correlator's event handlers and sweep over real Postgres (SENTRA-13)."""

import uuid
from dataclasses import replace

import pytest
from correlate_support import FIXED_AT_0_10, TRAC, World

from pipeline import events
from pipeline.correlate.config import Limits
from pipeline.correlate.process import Deps, handle, handle_normalized, handle_parsed
from pipeline.correlate.store import Store
from pipeline.correlate.sweep import Sweep
from pipeline.normalize.events import vulnerabilities_normalized


class Spy(Store):
    """A Store that records which projects were reconciled."""

    def __init__(self, url: str):
        super().__init__(url)
        self.reconciled: list[str] = []

    def reconcile(self, project_id: str):
        self.reconciled.append(project_id)
        return super().reconcile(project_id)


@pytest.fixture
def deps(world: World):
    stores: list[Store] = []

    def make(**limits) -> Deps:
        store = Spy(world.url)
        stores.append(store)
        return Deps(store=store, limits=replace(Limits(), **limits))

    yield make
    for s in stores:
        s.close()


def parsed_event(world: World, import_id: str, **over) -> dict:
    event = events.sbom_parsed(import_id, str(world.org), str(world.project), "corr-1", 1)
    return {**event, **over}


def normalized_event() -> dict:
    return vulnerabilities_normalized(str(uuid.uuid4()), "corr-1", "osv", "PyPI", "a" * 64, 1, 1, 0, 0)


def runs(world: World) -> list[tuple]:
    return world.admin.execute("SELECT status, confirmed, unverifiable, matcher_version FROM match_runs").fetchall()


def vulnerable(world: World) -> str:
    imp = world.sbom([TRAC])
    world.advisory("PYSEC-1", "PyPI", "trac", ranges=FIXED_AT_0_10)
    return imp


# -- sbom.parsed ----------------------------------------------------------------------------------


def test_a_parsed_event_reconciles_the_project_and_records_a_completed_run(world: World, deps):
    imp = vulnerable(world)

    assert handle_parsed(parsed_event(world, imp), deps()) == "reconciled"

    assert [f["status"] for f in world.findings()] == ["open"]
    assert runs(world) == [("completed", 1, 0, 1)]


def test_redelivery_is_a_duplicate_and_changes_nothing(world: World, deps):
    imp = vulnerable(world)
    d = deps()
    handle_parsed(parsed_event(world, imp), d)
    before = world.admin.execute("SELECT id, updated_at FROM findings").fetchall()
    d.store.reconciled.clear()  # type: ignore[attr-defined]

    assert handle_parsed(parsed_event(world, imp), d) == "skipped_duplicate"

    assert d.store.reconciled == []  # type: ignore[attr-defined]
    assert world.admin.execute("SELECT id, updated_at FROM findings").fetchall() == before


def test_tenant_and_project_come_from_the_database_not_the_event(world: World, deps):
    imp = vulnerable(world)
    forged = parsed_event(world, imp, orgId=str(uuid.uuid4()), projectId=str(uuid.uuid4()))

    assert handle_parsed(forged, deps()) == "reconciled"

    (f,) = world.findings()
    assert (f["org_id"], f["project_id"]) == (world.org, world.project)
    assert world.admin.execute("SELECT count(*) FROM findings").fetchone() == (1,)


def test_unknown_stale_and_invalid_events_are_skipped(world: World, deps):
    uploaded = world.sbom([TRAC], status="uploaded")

    assert handle_parsed(parsed_event(world, str(uuid.uuid4())), deps()) == "skipped_missing"
    assert handle_parsed(parsed_event(world, uploaded), deps()) == "skipped_stale"
    assert handle_parsed({"type": "sbom.parsed"}, deps()) == "dropped_invalid"
    assert runs(world) == []


def test_a_failed_reconcile_marks_the_run_failed_and_redelivery_retakes_it(world: World, deps, monkeypatch):
    imp = vulnerable(world)
    d = deps()
    with monkeypatch.context() as m:
        m.setattr(d.store, "reconcile", lambda _p: (_ for _ in ()).throw(ConnectionError("db down")))
        with pytest.raises(ConnectionError):
            handle_parsed(parsed_event(world, imp), d)
    assert runs(world) == [("failed", 0, 0, 1)]

    assert handle_parsed(parsed_event(world, imp), d) == "reconciled"

    assert runs(world) == [("completed", 1, 0, 1)]


def test_a_live_lease_blocks_other_workers_and_an_expired_one_is_retaken(world: World, deps):
    imp = vulnerable(world)
    handle_parsed(parsed_event(world, imp), deps())
    world.admin.execute("UPDATE match_runs SET status = 'running', claimed_until = now() + interval '5 minutes'")

    assert handle_parsed(parsed_event(world, imp), deps()) == "skipped_duplicate"

    world.admin.execute("UPDATE match_runs SET claimed_until = now() - interval '1 second'")
    assert handle_parsed(parsed_event(world, imp), deps()) == "reconciled"
    assert runs(world)[0][0] == "completed"


def test_a_new_matcher_version_reconciles_an_import_again(world: World, deps):
    imp = vulnerable(world)
    handle_parsed(parsed_event(world, imp), deps())
    world.admin.execute("UPDATE match_runs SET matcher_version = 0")

    assert handle_parsed(parsed_event(world, imp), deps()) == "reconciled"

    assert sorted(r[3] for r in runs(world)) == [0, 1]


# -- vulnerabilities.normalized -------------------------------------------------------------------


def test_the_first_normalized_event_reconciles_everything_that_matches_and_sets_the_watermark(world: World, deps):
    org2, project2 = world.second_project()
    vulnerable(world)
    world.sbom([("pkg:pypi/other@1.0", "PyPI", None, "other", "1.0")], org=org2, project=project2)
    d = deps()

    assert handle_normalized(normalized_event(), d) == "reconciled"

    assert d.store.reconciled == [str(world.project)]  # type: ignore[attr-defined]
    assert d.store.watermark() == d.store.advisory_high_water()


def test_later_events_reconcile_only_projects_touched_by_advisories_changed_since_the_watermark(world: World, deps):
    org2, project2 = world.second_project()
    vulnerable(world)
    world.sbom([("pkg:pypi/b@1.0", "PyPI", None, "b", "1.0")], org=org2, project=project2)
    d = deps(watermark_overlap_seconds=0)
    handle_normalized(normalized_event(), d)
    d.store.reconciled.clear()  # type: ignore[attr-defined]

    assert handle_normalized(normalized_event(), d) == "reconciled"
    assert d.store.reconciled == []  # type: ignore[attr-defined]

    world.advisory("PYSEC-2", "PyPI", "b", versions=["1.0"])  # new advisory for the other project only
    handle_normalized(normalized_event(), d)

    assert d.store.reconciled == [str(project2)]  # type: ignore[attr-defined]
    assert [f["source_id"] for f in world.findings(project2)] == ["PYSEC-2"]


def test_an_advisory_committed_late_with_an_older_timestamp_is_still_picked_up(world: World, deps):
    vulnerable(world)
    d = deps()  # default overlap
    handle_normalized(normalized_event(), d)
    # A normalizer batch stamped `updated_at` when its transaction began, but committed after we looked.
    late = world.advisory("PYSEC-LATE", "PyPI", "trac", versions=["0.9"])
    world.admin.execute("UPDATE vulnerabilities SET updated_at = now() - interval '2 minutes' WHERE id = %s", (late,))

    handle_normalized(normalized_event(), d)

    assert {f["source_id"] for f in world.findings()} == {"PYSEC-1", "PYSEC-LATE"}


def test_a_withdrawn_advisory_resolves_its_findings_through_the_event(world: World, deps):
    imp = vulnerable(world)
    d = deps()
    handle_parsed(parsed_event(world, imp), d)
    handle_normalized(normalized_event(), d)
    world.admin.execute("UPDATE vulnerabilities SET withdrawn_at = now(), updated_at = now()")

    handle_normalized(normalized_event(), d)

    assert [(f["status"], f["resolved_reason"]) for f in world.findings()] == [("resolved", "advisory_withdrawn")]


def test_an_advisory_that_drops_the_package_resolves_the_finding(world: World, deps):
    imp = vulnerable(world)
    d = deps()
    handle_parsed(parsed_event(world, imp), d)
    vuln = world.admin.execute("SELECT id FROM vulnerabilities").fetchone()[0]  # type: ignore[index]
    world.admin.execute("DELETE FROM vulnerability_affected WHERE vulnerability_id = %s", (vuln,))
    world.affect(vuln, "PyPI", "something-else", versions=["1.0"])  # the advisory no longer names trac
    world.admin.execute("UPDATE vulnerabilities SET updated_at = now()")

    handle_normalized(normalized_event(), d)

    assert [(f["status"], f["resolved_reason"]) for f in world.findings()] == [("resolved", "advisory_updated")]


def test_an_empty_vulnerability_table_is_skipped(world: World, deps):
    assert handle_normalized(normalized_event(), deps()) == "skipped_empty"


def test_handle_dispatches_on_the_event_type_and_drops_unknown_ones(world: World, deps):
    assert handle({"type": "something.else"}, deps()) == "dropped_invalid"
    assert handle(normalized_event(), deps()) == "skipped_empty"


# -- sweep ------------------------------------------------------------------------------------------


def drain(sweep: Sweep) -> None:
    assert sweep.maybe_start()
    while sweep.step():
        pass


def test_the_sweep_heals_findings_that_no_event_ever_announced(world: World, deps):
    vulnerable(world)  # an import and an advisory, and no events at all
    sweep = Sweep(deps())

    drain(sweep)

    assert [f["status"] for f in world.findings()] == ["open"]


def test_the_sweep_runs_in_bounded_batches_across_all_projects(world: World, deps):
    org2, project2 = world.second_project()
    vulnerable(world)
    world.sbom([TRAC], org=org2, project=project2)
    d = deps(sweep_batch=1)
    sweep = Sweep(d)

    assert sweep.maybe_start()
    assert sweep.step() is True  # one project, more remain
    assert len(d.store.reconciled) == 1  # type: ignore[attr-defined]
    while sweep.step():
        pass

    assert sorted(d.store.reconciled) == sorted([str(world.project), str(project2)])  # type: ignore[attr-defined]
    assert len(world.findings()) == 1 and len(world.findings(project2)) == 1


def test_a_sweep_is_not_due_again_until_the_interval_has_passed(world: World, deps):
    vulnerable(world)
    drain(Sweep(deps()))

    assert Sweep(deps()).maybe_start() is False

    world.admin.execute("UPDATE correlation_state SET watermark = now() - interval '2 days' WHERE name = 'sweep'")
    assert Sweep(deps()).maybe_start() is True


def test_only_one_worker_holds_the_sweep_lease_and_a_lost_lease_stops_the_loser(world: World, deps):
    vulnerable(world)
    first, second = Sweep(deps()), Sweep(deps())
    assert first.maybe_start() is True
    assert second.maybe_start() is False

    world.admin.execute("UPDATE correlation_state SET claimed_until = now() - interval '1 second' WHERE name = 'sweep'")
    assert first.step() is False and first.active is False  # lease lost, it stands down
    assert second.maybe_start() is True  # and another worker can take over


def test_sweeping_resolves_findings_of_a_project_whose_package_left_and_writes_nothing_on_rerun(world: World, deps):
    imp = vulnerable(world)
    handle_parsed(parsed_event(world, imp), deps())
    world.sbom([("pkg:pypi/other@1.0", "PyPI", None, "other", "1.0")])
    drain(Sweep(deps()))
    assert [(f["status"], f["resolved_reason"]) for f in world.findings()] == [("resolved", "dependency_removed")]
    before = world.admin.execute("SELECT id, updated_at, xmin::text FROM findings").fetchall()

    world.admin.execute("UPDATE correlation_state SET watermark = now() - interval '2 days' WHERE name = 'sweep'")
    drain(Sweep(deps()))

    assert world.admin.execute("SELECT id, updated_at, xmin::text FROM findings").fetchall() == before
