import hashlib
import json
import threading

import psycopg
import pytest

from conftest import make_request
from crawler import contracts
from crawler.ingest import handle
from fake_osv import FIXTURES, Response, make_zip

NPM = "/npm/all.zip"


def row(admin, run_id):
    cur = admin.execute(
        "SELECT status, artifact_key, sha256, etag, size_bytes, attempts, error, claimed_until "
        "FROM ingestion_runs WHERE run_id = %s",
        (run_id,),
    )
    r = cur.fetchone()
    assert r, "run row missing"
    return dict(zip(["status", "key", "sha256", "etag", "size", "attempts", "error", "lease"], r, strict=True))


def test_happy_path_stores_raw_zip_then_publishes_event(harness, admin):
    body = make_zip()
    sha = hashlib.sha256(body).hexdigest()
    harness.osv.serve(NPM, Response(body=body, etag='"v1"'))
    req = make_request()

    assert handle(req, harness.deps()) == "published"

    key = f"raw/osv/npm/{sha}.zip"
    stored = harness.s3.get_object(Bucket=harness.bucket, Key=key)["Body"].read()
    assert stored == body  # raw, untouched
    sidecar = json.loads(harness.s3.get_object(Bucket=harness.bucket, Key=f"raw/osv/npm/{sha}.json")["Body"].read())
    assert sidecar["runId"] == req["runId"] and sidecar["etag"] == '"v1"'
    assert sorted(harness.objects()) == [f"raw/osv/npm/{sha}.json", key]  # no tmp/ leftovers

    r = row(admin, req["runId"])
    assert (r["status"], r["key"], r["sha256"], r["etag"], r["size"], r["lease"]) == (
        "published",
        key,
        sha,
        '"v1"',
        len(body),
        None,
    )

    (event,) = harness.published
    contracts.validate("artifact.ingested", event)
    assert event["runId"] == req["runId"] and event["correlationId"] == "it-corr-1"
    assert event["artifact"] == {"bucket": harness.bucket, "key": key, "sha256": sha, "sizeBytes": len(body)}


def test_duplicate_delivery_of_same_run_does_not_refetch_or_republish(harness, admin):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    req = make_request()
    assert handle(req, harness.deps()) == "published"
    assert handle(req, harness.deps()) == "skipped"
    assert harness.osv.count(NPM) == 1 and len(harness.published) == 1
    assert admin.execute("SELECT count(*) FROM ingestion_runs").fetchone()[0] == 1


def test_unchanged_upstream_304_ends_run_without_new_artifact_or_event(harness, admin):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    assert handle(make_request(), harness.deps()) == "published"
    objects_before = harness.objects()

    harness.osv.serve(NPM, Response(status=304))
    second = make_request()
    assert handle(second, harness.deps()) == "unchanged"

    assert harness.osv.requests[-1][1]["If-None-Match"] == '"v1"'
    assert harness.objects() == objects_before and len(harness.published) == 1
    r = row(admin, second["runId"])
    assert r["status"] == "unchanged" and r["etag"] == '"v1"' and r["sha256"]


def test_identical_content_with_new_etag_is_unchanged_not_a_duplicate(harness, admin):
    body = make_zip()
    harness.osv.serve(NPM, Response(body=body, etag='"v1"'))
    assert handle(make_request(), harness.deps()) == "published"
    harness.osv.serve(NPM, Response(body=body, etag='"v2"'))
    assert handle(make_request(), harness.deps()) == "unchanged"
    assert len(harness.objects()) == 2 and len(harness.published) == 1


def test_changed_content_is_a_new_immutable_artifact(harness):
    harness.osv.serve(NPM, Response(body=make_zip("GHSA-3h5v-q93c-6h6q.json"), etag='"v1"'))
    assert handle(make_request(), harness.deps()) == "published"
    harness.osv.serve(NPM, Response(body=make_zip("PYSEC-2023-74.json"), etag='"v2"'))
    assert handle(make_request(), harness.deps()) == "published"
    assert len(harness.objects()) == 4  # two zips + two sidecars; the first is untouched
    assert len({e["artifact"]["sha256"] for e in harness.published}) == 2


def test_ecosystems_are_stored_and_tracked_separately(harness):
    harness.osv.serve(NPM, Response(body=make_zip("GHSA-3h5v-q93c-6h6q.json"), etag='"n"'))
    harness.osv.serve("/PyPI/all.zip", Response(body=make_zip("PYSEC-2023-74.json"), etag='"p"'))
    assert handle(make_request(ecosystem="npm"), harness.deps()) == "published"
    assert handle(make_request(ecosystem="PyPI"), harness.deps()) == "published"
    assert {e["ecosystem"] for e in harness.published} == {"npm", "PyPI"}
    assert {k.split("/")[2] for k in harness.objects()} == {"npm", "PyPI"}


def test_exhausted_retries_fail_the_run_and_publish_crawl_failed(harness, admin):
    harness.osv.serve(NPM, Response(status=503))
    req = make_request()
    assert handle(req, harness.deps()) == "failed"

    assert harness.osv.count(NPM) == 3  # bounded: max_attempts
    r = row(admin, req["runId"])
    assert r["status"] == "failed" and r["attempts"] == 3 and "503" in r["error"] and r["lease"] is None
    (event,) = harness.published
    contracts.validate("crawl.failed", event, version=2)
    assert event["runId"] == req["runId"] and event["attempts"] == 3 and event["failureKind"] == "transient"
    kind, started, completed = admin.execute(
        "SELECT failure_kind, started_at, completed_at FROM ingestion_runs WHERE run_id = %s", (req["runId"],)
    ).fetchone()
    assert kind == "transient" and started is not None and completed >= started
    # A redelivery does not resurrect it: retrying means a new request with a new runId.
    assert handle(req, harness.deps()) == "skipped"
    assert harness.osv.count(NPM) == 3 and len(harness.published) == 1


def test_non_retryable_error_fails_immediately(harness, admin):
    harness.osv.serve(NPM, Response(status=404))
    req = make_request()
    assert handle(req, harness.deps()) == "failed"
    assert harness.osv.count(NPM) == 1 and row(admin, req["runId"])["attempts"] == 1
    assert harness.published[0]["failureKind"] == "permanent"
    assert admin.execute("SELECT failure_kind FROM ingestion_runs").fetchone() == ("permanent",)


def test_crash_between_stored_and_published_resumes_without_refetching(harness, admin):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    req = make_request()
    harness.publish_failures = 1

    with pytest.raises(ConnectionError):
        handle(req, harness.deps())
    r = row(admin, req["runId"])
    assert r["status"] == "stored" and r["key"] and r["lease"] is None  # durable, and resumable right away
    assert harness.published == []

    assert handle(req, harness.deps()) == "published"  # the redelivery
    assert harness.osv.count(NPM) == 1  # resumed from storage, no second download
    assert row(admin, req["runId"])["status"] == "published" and len(harness.published) == 1


def test_republished_event_has_the_same_event_id_so_consumers_can_dedupe(harness):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    req = make_request()
    first = harness.deps()
    first.publish = lambda e: harness.published.append(e)
    handle(req, first)
    # Simulate "published but offset never committed": reset the run to stored and process again.
    admin_url = harness.crawler_url
    with psycopg.connect(admin_url, autocommit=True) as c:
        c.execute("UPDATE ingestion_runs SET status = 'stored' WHERE run_id = %s", (req["runId"],))
    handle(req, harness.deps())
    assert len(harness.published) == 2 and harness.published[0]["eventId"] == harness.published[1]["eventId"]


def test_storage_failure_never_leaves_a_partial_object_and_run_resumes(harness, admin, monkeypatch):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    req = make_request()
    deps = harness.deps()
    real_copy = deps.store.s3.copy_object
    monkeypatch.setattr(deps.store.s3, "copy_object", lambda **kw: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError, match="disk full"):
        handle(req, deps)
    assert harness.objects() == []  # nothing at the final key, temp upload cleaned up
    assert row(admin, req["runId"])["status"] == "fetching"

    monkeypatch.setattr(deps.store.s3, "copy_object", real_copy)
    assert handle(req, harness.deps()) == "published"


def test_two_workers_on_the_same_run_fetch_once(harness):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"', delay=0.5))
    req = make_request()
    outcomes: list[str] = []

    def work():
        outcomes.append(handle(req, harness.deps()))

    threads = [threading.Thread(target=work) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(outcomes) == ["published", "skipped"]
    assert harness.osv.count(NPM) == 1 and len(harness.published) == 1


def test_live_lease_blocks_other_workers_but_expired_lease_is_reclaimed(harness, admin):
    harness.osv.serve(NPM, Response(body=make_zip(), etag='"v1"'))
    req = make_request()
    admin.execute(
        "INSERT INTO ingestion_runs (run_id, source, ecosystem, correlation_id, claimed_until) "
        "VALUES (%s, 'osv', 'npm', 'c', now() + interval '10 minutes')",
        (req["runId"],),
    )
    assert handle(req, harness.deps()) == "skipped" and harness.osv.count(NPM) == 0
    admin.execute("UPDATE ingestion_runs SET claimed_until = now() - interval '1 second'")
    assert handle(req, harness.deps()) == "published"  # the previous worker died; lease lapsed


@pytest.mark.parametrize(
    ("make", "outcome"),
    [
        (lambda: {**make_request(), "signature": "0" * 64}, "dropped_signature"),
        (lambda: make_request(key_id="rotated-away"), "dropped_signature"),
        (lambda: {**make_request(), "ecosystem": "PyPI", "keyId": "k1"}, "dropped_signature"),  # tampered after signing
        (lambda: make_request(ecosystem="Maven"), "dropped_unsupported"),
        (lambda: make_request(source="ghsa"), "dropped_unsupported"),
        (lambda: {k: v for k, v in make_request().items() if k != "runId"}, "dropped_invalid"),
        (lambda: {**make_request(), "url": "http://169.254.169.254/"}, "dropped_invalid"),
    ],
    ids=[
        "bad-sig",
        "unknown-key",
        "tampered",
        "unsupported-ecosystem",
        "unsupported-source",
        "missing-runid",
        "smuggled-url",
    ],
)
def test_bad_requests_are_dropped_without_creating_a_run_or_fetching(harness, admin, make, outcome):
    harness.osv.serve(NPM, Response(body=make_zip()))
    assert handle(make(), harness.deps()) == outcome
    assert admin.execute("SELECT count(*) FROM ingestion_runs").fetchone()[0] == 0
    assert harness.osv.requests == [] and harness.published == []


def test_run_id_reused_for_a_different_source_is_not_processed(harness, admin):
    harness.osv.serve(NPM, Response(body=make_zip()))
    harness.osv.serve("/PyPI/all.zip", Response(body=make_zip()))
    run_id = make_request()["runId"]
    assert handle(make_request(run_id=run_id, ecosystem="npm"), harness.deps()) == "published"
    assert handle(make_request(run_id=run_id, ecosystem="PyPI"), harness.deps()) == "skipped"
    assert harness.osv.count("/PyPI/all.zip") == 0


def test_crawler_role_is_least_privilege(database, admin):
    with psycopg.connect(database[1], autocommit=True) as conn:
        conn.execute("SELECT count(*) FROM ingestion_runs")
        for statement in ("DELETE FROM ingestion_runs", "SELECT * FROM users", "DROP TABLE ingestion_runs"):
            with pytest.raises(psycopg.errors.Error):
                conn.execute(statement)  # type: ignore[arg-type]


KEV = "/kev.json"
KEV_BODY = (FIXTURES / "kev" / "catalog.json").read_bytes()  # a real slice of the CISA catalog


def test_kev_catalog_is_stored_raw_as_json_then_published(harness, admin):
    sha = hashlib.sha256(KEV_BODY).hexdigest()
    harness.osv.serve(KEV, Response(body=KEV_BODY, etag='"k1"'))
    req = make_request(source="cisa-kev", ecosystem="none")

    assert handle(req, harness.deps()) == "published"

    key = f"raw/cisa-kev/none/{sha}.json"
    assert harness.s3.get_object(Bucket=harness.bucket, Key=key)["Body"].read() == KEV_BODY
    assert sorted(harness.objects()) == [key, f"raw/cisa-kev/none/{sha}.meta.json"]  # sidecar must not clobber it
    (event,) = harness.published
    contracts.validate("artifact.ingested", event)
    assert event["source"] == "cisa-kev" and event["artifact"]["key"] == key
    assert row(admin, req["runId"])["status"] == "published"


def test_kev_rerun_with_unchanged_catalog_is_a_noop(harness, admin):
    harness.osv.serve(KEV, Response(body=KEV_BODY, etag='"k1"'))
    assert handle(make_request(source="cisa-kev", ecosystem="none"), harness.deps()) == "published"
    objects_before = harness.objects()

    harness.osv.serve(KEV, Response(status=304))
    assert handle(make_request(source="cisa-kev", ecosystem="none"), harness.deps()) == "unchanged"
    assert harness.osv.requests[-1][1]["If-None-Match"] == '"k1"'
    assert harness.objects() == objects_before and len(harness.published) == 1


def test_kev_html_error_page_served_as_200_fails_the_run_without_storing(harness, admin):
    harness.osv.serve(KEV, Response(body=b"<html>maintenance</html>"))
    req = make_request(source="cisa-kev", ecosystem="none")

    assert handle(req, harness.deps()) == "failed"

    assert harness.objects() == []
    assert row(admin, req["runId"])["status"] == "failed"
    assert harness.published[0]["type"] == "crawl.failed"


def test_kev_with_an_ecosystem_is_dropped_as_unsupported(harness, admin):
    assert handle(make_request(source="cisa-kev", ecosystem="npm"), harness.deps()) == "dropped_unsupported"
    assert harness.osv.requests == []
