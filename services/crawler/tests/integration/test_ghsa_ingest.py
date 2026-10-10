"""GHSA ingestion against real Postgres and S3, with a real local HTTP server as the GitHub API."""

import dataclasses
import io
import json
import logging
import zipfile
from datetime import timedelta

import pytest

from conftest import GITHUB_TOKEN, make_request
from crawler import contracts, ghsa
from crawler.ingest import handle
from fake_github import START, Reply, make_advisories

NEWEST_OF_60 = START + timedelta(minutes=10) * 59


def ghsa_request(**over):
    return make_request(source="ghsa", ecosystem="none", **over)


def run_row(admin, run_id):
    cur = admin.execute(
        "SELECT status, artifact_key, sha256, error, watermark FROM ingestion_runs WHERE run_id = %s", (run_id,)
    )
    return dict(zip(["status", "key", "sha256", "error", "watermark"], cur.fetchone(), strict=True))


def test_first_run_stores_one_bundle_of_unmodified_pages_publishes_once_and_records_the_watermark(harness, admin):
    harness.github.advisories = make_advisories(250)
    req = ghsa_request()

    assert handle(req, harness.deps()) == "published"

    (event,) = harness.published
    contracts.validate("artifact.ingested", event)
    assert (event["source"], event["ecosystem"]) == ("ghsa", "none")
    key, sha = event["artifact"]["key"], event["artifact"]["sha256"]
    assert key == f"raw/ghsa/none/{sha}.zip"
    bundle = harness.s3.get_object(Bucket=harness.bucket, Key=key)["Body"].read()
    with zipfile.ZipFile(io.BytesIO(bundle)) as z:
        assert [z.read(n) for n in z.namelist()] == harness.github.served and len(z.namelist()) == 3
    sidecar = json.loads(harness.s3.get_object(Bucket=harness.bucket, Key=f"raw/ghsa/none/{sha}.json")["Body"].read())
    assert sidecar["sourceUrl"] == f"{harness.github.base_url}/advisories"
    assert (sidecar["bundleFormat"], sidecar["modifiedFrom"]) == (ghsa.BUNDLE_FORMAT, None)
    assert sorted(harness.objects()) == [f"raw/ghsa/none/{sha}.json", key]
    r = run_row(admin, req["runId"])
    assert (r["status"], r["watermark"]) == ("published", START + timedelta(minutes=10) * 249)


def test_incremental_run_fetches_only_the_window_and_converges_on_the_overlap(harness, admin):
    harness.github.advisories = make_advisories(60)
    assert handle(ghsa_request(), harness.deps()) == "published"
    harness.github.advisories = make_advisories(70)  # ten new advisories after the watermark
    harness.github.requests.clear()
    harness.github.served.clear()

    second = ghsa_request()
    assert handle(second, harness.deps()) == "published"

    (path, _) = harness.github.requests[0]
    assert "modified=" in path and len(harness.github.requests) == 1
    served = json.loads(harness.github.served[0])
    assert len(served) == 17  # 6 overlap rows before the watermark, the watermark row itself, 10 new
    sidecar_key = f"raw/ghsa/none/{harness.published[1]['artifact']['sha256']}.json"
    sidecar = json.loads(harness.s3.get_object(Bucket=harness.bucket, Key=sidecar_key)["Body"].read())
    assert sidecar["modifiedFrom"] == (NEWEST_OF_60 - ghsa.OVERLAP).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert run_row(admin, second["runId"])["watermark"] == START + timedelta(minutes=10) * 69


def test_a_run_with_no_changes_ends_unchanged_without_an_artifact_or_event_and_keeps_the_watermark(harness, admin):
    harness.github.advisories = make_advisories(60)
    assert handle(ghsa_request(), harness.deps()) == "published"
    objects = harness.objects()

    third = ghsa_request()
    assert handle(third, harness.deps()) == "unchanged"

    assert harness.objects() == objects and len(harness.published) == 1
    r = run_row(admin, third["runId"])
    assert (r["status"], r["watermark"]) == ("unchanged", NEWEST_OF_60)
    # The watermark survives the unchanged run: the next change is still found.
    harness.github.advisories = make_advisories(61)
    assert handle(ghsa_request(), harness.deps()) == "published"


def test_a_failure_part_way_stores_nothing_and_the_retry_covers_the_same_window(harness, admin):
    harness.github.advisories = make_advisories(60)
    assert handle(ghsa_request(), harness.deps()) == "published"
    harness.github.advisories = make_advisories(260)  # 200 new advisories: two pages after the overlap
    objects = harness.objects()
    ok = harness.github._page
    served = []

    def second_page_dies(path):
        served.append(path)
        return Reply(502) if len(served) == 2 else ok(path)

    harness.github._page = second_page_dies  # type: ignore[method-assign]
    harness.github.script = []
    harness.limits = dataclasses.replace(harness.limits, max_attempts=1)
    failed = ghsa_request()
    assert handle(failed, harness.deps()) == "failed"

    assert harness.objects() == objects  # nothing was stored
    assert [e["type"] for e in harness.published] == ["artifact.ingested", "crawl.failed"]  # no second artifact
    r = run_row(admin, failed["runId"])
    assert r["status"] == "failed" and "502" in r["error"] and r["watermark"] is None

    harness.github._page = ok  # type: ignore[method-assign]
    retry = ghsa_request()
    assert handle(retry, harness.deps()) == "published"
    assert run_row(admin, retry["runId"])["watermark"] == START + timedelta(minutes=10) * 259
    assert "modified=" in harness.github.requests[-3][0]  # still asked from the last *successful* watermark


def test_rate_limit_beyond_the_budget_is_a_distinct_outcome_and_leaves_no_artifact(harness, admin):
    harness.github.advisories = make_advisories(60)
    harness.github.script = [Reply(403, b"{}", {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "4102444800"})]
    req = ghsa_request()

    assert handle(req, harness.deps()) == "rate_limited"

    assert harness.objects() == []
    (failed,) = harness.published
    contracts.validate("crawl.failed", failed, version=2)
    assert "rate limited" in failed["reason"] and failed["failureKind"] == "transient"
    r = run_row(admin, req["runId"])
    assert r["status"] == "failed" and "rate limited" in r["error"] and r["watermark"] is None


def test_missing_token_fails_the_run_before_any_request(harness, admin):
    harness.github.advisories = make_advisories(60)
    deps = dataclasses.replace(harness.deps(), github_token=None)
    req = ghsa_request()

    assert handle(req, deps) == "failed"

    assert harness.github.requests == [] and harness.objects() == []
    (failed,) = harness.published
    assert "CRAWLER_GITHUB_TOKEN" in failed["reason"]


def test_the_watermark_only_counts_once_the_event_is_published(harness, admin):
    harness.github.advisories = make_advisories(60)
    harness.publish_failures = 1  # the broker is down at the moment of publishing
    req = ghsa_request()
    with pytest.raises(ConnectionError):
        handle(req, harness.deps())

    deps = harness.deps()
    assert run_row(admin, req["runId"])["status"] == "stored"
    assert deps.runs.latest_published("ghsa", "none") is None  # stored is not a baseline

    assert handle(req, deps) == "published"  # the redelivery resumes at publishing, without refetching
    assert len(harness.github.requests) == 1
    latest = deps.runs.latest_published("ghsa", "none")
    assert latest is not None and latest.watermark == NEWEST_OF_60


def test_a_duplicate_request_does_not_fetch_again(harness):
    harness.github.advisories = make_advisories(60)
    req = ghsa_request()
    assert handle(req, harness.deps()) == "published"
    assert handle(req, harness.deps()) == "skipped"
    assert len(harness.github.requests) == 1 and len(harness.published) == 1


def test_the_token_appears_in_no_log_event_sidecar_or_run_record(harness, admin, caplog):
    caplog.set_level(logging.DEBUG)
    harness.github.advisories = make_advisories(60)
    ok_run = ghsa_request()
    assert handle(ok_run, harness.deps()) == "published"
    harness.github.script = [Reply(401, b'{"message":"Bad credentials"}')]
    harness.github.advisories = make_advisories(70)
    rejected = ghsa_request()
    assert handle(rejected, harness.deps()) == "failed"

    secret = GITHUB_TOKEN.reveal()
    assert secret in {h["Authorization"].removeprefix("Bearer ") for _, h in harness.github.requests}  # it was used
    stored = [
        harness.s3.get_object(Bucket=harness.bucket, Key=k)["Body"].read().decode("latin-1") for k in harness.objects()
    ]
    runs = admin.execute("SELECT row_to_json(r)::text FROM ingestion_runs r").fetchall()
    surfaces = [caplog.text, json.dumps(harness.published), *stored, *(r[0] for r in runs)]
    assert all(secret not in surface for surface in surfaces)
    assert "Bearer" not in caplog.text
