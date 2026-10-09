import json
import os
import zipfile
from datetime import UTC, datetime, timedelta

import pytest

from crawler import ghsa
from crawler.config import Limits, Secret
from crawler.fetch import Downloaded, FetchFailed, NotModified
from crawler.ghsa import OVERLAP, RateLimited, fetch_advisories
from fake_github import START, FakeGitHub, Reply, make_advisories, stamp

TOKEN = Secret("ghp_unit_test_token_0123456789")
NOW = 1_800_000_000.0  # the fake clock for x-ratelimit-reset
LIMITS = Limits(read_timeout=2, connect_timeout=1, max_attempts=3, backoff_base=1, backoff_cap=4, total_timeout=600)


def run(
    github: FakeGitHub, *, since=None, token: Secret | None = TOKEN, limits=LIMITS, sleeps=None, tmp_path=None, **kw
):
    slept = sleeps if sleeps is not None else []
    return fetch_advisories(
        token,
        since=since,
        limits=limits,
        tmp_dir=str(tmp_path) if tmp_path else None,
        base_url=github.base_url,
        sleep=slept.append,
        rand=lambda: 1.0,
        now=lambda: NOW,
        **kw,
    )


def pages(result: Downloaded) -> dict[str, bytes]:
    with zipfile.ZipFile(result.path) as z:
        return {name: z.read(name) for name in z.namelist()}


def test_first_run_pages_through_every_advisory_and_stores_the_page_bodies_unmodified(tmp_path):
    github = FakeGitHub(make_advisories(250))  # 3 pages at the API's page size of 100
    try:
        result = run(github, tmp_path=tmp_path)
        assert isinstance(result, Downloaded)
        stored = pages(result)
        assert list(stored) == ["page-00001.json", "page-00002.json", "page-00003.json"]
        assert list(stored.values()) == github.served  # byte for byte what the API sent
        assert [len(json.loads(b)) for b in stored.values()] == [100, 100, 50]
        assert result.watermark == START + timedelta(minutes=10) * 249
        assert result.modified_from is None and result.attempts == 1 and result.etag is None
        first = github.requests[0][0]
        assert "type=reviewed" in first and "per_page=100" in first and "modified" not in first
        assert len(github.requests) == 3
        os.unlink(result.path)
    finally:
        github.close()
    assert list(tmp_path.iterdir()) == []


def test_every_request_carries_the_token_and_only_the_token_header_value_changes_nothing_else(github):
    github.advisories = make_advisories(150)
    result = run(github)
    os.unlink(result.path)  # type: ignore[union-attr]
    assert github.authorization_headers() == {"Bearer ghp_unit_test_token_0123456789"}
    assert {h["Accept"] for _, h in github.requests} == {"application/vnd.github+json"}


def test_incremental_run_asks_for_the_watermark_minus_the_overlap_and_returns_the_newer_data(github):
    github.advisories = make_advisories(30)
    watermark = START + timedelta(minutes=10) * 19  # advisory 19 was the newest seen last time
    result = run(github, since=watermark)
    assert isinstance(result, Downloaded)
    assert f"modified=%3E%3D{stamp(watermark - OVERLAP).replace(':', '%3A')}" in github.requests[0][0]
    served = json.loads(pages(result)["page-00001.json"])
    # The overlap re-fetches 6 advisories before the watermark (1 hour of 10-minute steps), then 10 newer ones.
    assert [a["ghsa_id"] for a in served][0] == github.advisories[13]["ghsa_id"]
    assert len(served) == 17
    assert result.watermark == START + timedelta(minutes=10) * 29
    assert result.modified_from == watermark - OVERLAP
    os.unlink(result.path)


def test_nothing_newer_than_the_watermark_is_not_modified_and_leaves_no_file(github, tmp_path):
    github.advisories = make_advisories(30)
    newest = START + timedelta(minutes=10) * 29
    assert isinstance(run(github, since=newest, tmp_path=tmp_path), NotModified)  # only overlap rows come back
    assert list(tmp_path.iterdir()) == []


def test_the_bundle_is_reproducible_so_identical_upstream_content_hashes_the_same(github):
    github.advisories = make_advisories(120)
    a, b = run(github), run(github)
    assert isinstance(a, Downloaded) and isinstance(b, Downloaded)
    assert (a.sha256, a.size) == (b.sha256, b.size)
    os.unlink(a.path)
    os.unlink(b.path)


def test_a_full_run_that_returns_nothing_fails_instead_of_looking_unchanged(github, tmp_path):
    with pytest.raises(FetchFailed, match="no advisories"):
        run(github, tmp_path=tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_missing_token_fails_before_any_request(github):
    with pytest.raises(FetchFailed, match="CRAWLER_GITHUB_TOKEN") as e:
        run(github, token=None)
    assert e.value.attempts == 0 and github.requests == []


def test_low_remaining_quota_is_paced_until_the_window_resets(github):
    github.advisories = make_advisories(150)
    github.remaining = 0  # the first page says the quota is spent
    github.script = []
    sleeps: list[float] = []
    original = github._page

    def with_reset(path):
        reply = original(path)
        reply.headers["x-ratelimit-reset"] = str(int(NOW) + 30)
        return reply

    github._page = with_reset  # type: ignore[method-assign]
    result = run(github, sleeps=sleeps)
    assert isinstance(result, Downloaded)
    assert sleeps == [31.0]  # until the reset, plus a second; paced before the second request, so no 403 was provoked
    assert len(github.requests) == 2
    os.unlink(result.path)


def test_primary_rate_limit_response_waits_for_the_reset_then_continues(github):
    github.advisories = make_advisories(10)
    github.script = [
        Reply(
            403,
            b'{"message":"API rate limit exceeded"}',
            {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(int(NOW) + 20)},
        )
    ]
    sleeps: list[float] = []
    result = run(github, sleeps=sleeps)
    assert isinstance(result, Downloaded) and result.attempts == 1  # waiting out a limit is not a retry
    assert sleeps == [21.0] and len(github.requests) == 2
    os.unlink(result.path)


def test_secondary_rate_limit_honours_retry_after(github):
    github.advisories = make_advisories(10)
    github.script = [Reply(429, b'{"message":"secondary rate limit"}', {"retry-after": "7"})]
    sleeps: list[float] = []
    os.unlink(run(github, sleeps=sleeps).path)  # type: ignore[union-attr]
    assert sleeps == [7.0]


def test_403_that_mentions_a_rate_limit_without_headers_waits_a_minute(github):
    github.advisories = make_advisories(10)
    github.script = [Reply(403, b'{"message":"You have exceeded a secondary rate limit."}')]
    sleeps: list[float] = []
    os.unlink(run(github, sleeps=sleeps).path)  # type: ignore[union-attr]
    assert sleeps == [ghsa.SECONDARY_LIMIT_WAIT]


def test_a_wait_longer_than_the_run_has_left_fails_as_rate_limited_without_sleeping(github, tmp_path):
    github.advisories = make_advisories(10)
    hour = str(int(NOW) + 3600)
    github.script = [Reply(403, b"{}", {"x-ratelimit-remaining": "0", "x-ratelimit-reset": hour})]
    sleeps: list[float] = []
    with pytest.raises(RateLimited, match="rate limited") as e:
        run(github, sleeps=sleeps, tmp_path=tmp_path, limits=Limits(total_timeout=300, max_attempts=3))
    assert isinstance(e.value, FetchFailed) and sleeps == [] and len(github.requests) == 1
    assert list(tmp_path.iterdir()) == []


def test_server_errors_back_off_then_succeed(github):
    github.advisories = make_advisories(10)
    github.script = [Reply(503), Reply(500)]
    sleeps: list[float] = []
    result = run(github, sleeps=sleeps)
    assert isinstance(result, Downloaded) and result.attempts == 3
    assert sleeps == [1.0, 2.0]
    os.unlink(result.path)


def test_server_errors_are_bounded_and_leave_no_file(github, tmp_path):
    github.script = [Reply(502)] * 10
    with pytest.raises(FetchFailed, match="http 502 after 3 attempts"):
        run(github, tmp_path=tmp_path)
    assert len(github.requests) == 3 and list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("status", [401, 404, 422])
def test_client_errors_fail_at_once_and_never_echo_the_token(github, status):
    github.script = [Reply(status, b'{"message":"nope"}')]
    with pytest.raises(FetchFailed) as e:
        run(github)
    assert e.value.reason == f"http {status}" and len(github.requests) == 1
    assert "ghp_" not in e.value.reason


def test_a_plain_403_is_a_failure_not_a_rate_limit(github):
    github.script = [Reply(403, b'{"message":"Resource not accessible"}')]
    sleeps: list[float] = []
    with pytest.raises(FetchFailed, match="http 403"):
        run(github, sleeps=sleeps)
    assert sleeps == []


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        (b"<html>gateway</html>", "not valid JSON"),
        (b'{"message":"oops"}', "not a JSON array"),
        (json.dumps([{"ghsa_id": "GHSA-x"}]).encode(), "valid updated_at"),
        (json.dumps([{"updated_at": "yesterday"}]).encode(), "valid updated_at"),
    ],
)
def test_a_malformed_page_fails_the_run_and_stores_nothing(github, tmp_path, body, reason):
    github.script = [Reply(200, body)]
    with pytest.raises(FetchFailed, match=reason):
        run(github, tmp_path=tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_failure_on_a_later_page_discards_the_pages_already_fetched(github, tmp_path):
    github.advisories = make_advisories(250)
    original = github._page
    calls = []

    def flaky(path):
        calls.append(path)
        return Reply(200, b"not json") if len(calls) == 3 else original(path)

    github._page = flaky  # type: ignore[method-assign]
    with pytest.raises(FetchFailed, match="page 3 is not valid JSON"):
        run(github, tmp_path=tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_a_next_link_to_another_host_is_refused_and_the_token_is_not_sent_there(github, tmp_path):
    elsewhere = FakeGitHub(make_advisories(5))
    try:
        github.advisories = make_advisories(150)
        github.next_link_override = f"{elsewhere.base_url}/advisories?after=100"
        with pytest.raises(FetchFailed, match="outside the GitHub API"):
            run(github, tmp_path=tmp_path)
        assert elsewhere.requests == []
        assert list(tmp_path.iterdir()) == []
    finally:
        elsewhere.close()


def test_a_repeating_next_link_is_refused(github):
    github.advisories = make_advisories(250)
    github.next_link_override = (
        f"{github.base_url}/advisories?type=reviewed&sort=updated&direction=asc&per_page=100&after=100"
    )
    with pytest.raises(FetchFailed, match="repeats"):
        run(github)


def test_redirects_are_not_followed(github):
    github.script = [Reply(302, b"", {"Location": "https://example.com/steal"})]
    with pytest.raises(FetchFailed, match="http 302"):
        run(github)
    assert len(github.requests) == 1


def test_the_api_origin_is_https_api_github_com_and_other_plain_http_hosts_are_refused():
    assert ghsa.GITHUB_API == "https://api.github.com"
    with pytest.raises(RuntimeError, match="https"):
        fetch_advisories(TOKEN, since=None, limits=LIMITS, base_url="http://api.github.com")


def test_since_is_timezone_aware_utc_in_the_request():
    local = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)
    assert ghsa.first_url("https://x", local).endswith("modified=%3E%3D2026-10-05T11%3A00%3A00Z")


def test_a_run_budget_that_outlasts_the_overlap_window_is_refused(github):
    with pytest.raises(RuntimeError, match="OVERLAP"):
        run(github, limits=Limits(total_timeout=OVERLAP.total_seconds()))
    assert github.requests == []
