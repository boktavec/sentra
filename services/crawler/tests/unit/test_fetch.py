import os

import pytest

from crawler.config import Limits
from crawler.fetch import Downloaded, FetchFailed, NotModified, fetch
from fake_osv import Response, make_zip

PATH = "/npm/all.zip"
FAST = Limits(read_timeout=0.3, connect_timeout=1, max_attempts=5, backoff_base=1, backoff_cap=4)


def run(osv, *, etag=None, limits=FAST, sleeps=None):
    slept = sleeps if sleeps is not None else []
    return fetch(osv.base_url + PATH, etag=etag, limits=limits, sleep=slept.append, rand=lambda: 1.0)


def test_downloads_zip_and_reports_hash_size_and_etag(osv, tmp_path):
    body = make_zip()
    osv.serve(PATH, Response(body=body, etag='"abc"'))
    result = run(osv)
    assert isinstance(result, Downloaded)
    try:
        assert result.size == len(body) and result.etag == '"abc"' and result.attempts == 1
        assert open(result.path, "rb").read() == body
    finally:
        os.unlink(result.path)


def test_sends_if_none_match_and_handles_304(osv):
    osv.serve(PATH, Response(status=304))
    assert isinstance(run(osv, etag='"abc"'), NotModified)
    assert osv.requests[0][1]["If-None-Match"] == '"abc"'


def test_retries_429_and_5xx_with_exponential_backoff_then_succeeds(osv):
    osv.serve(
        PATH,
        Response(status=429),
        Response(status=503),
        Response(status=500),
        Response(status=502),
        Response(body=make_zip()),
    )
    sleeps: list[float] = []
    result = run(osv, sleeps=sleeps)
    assert isinstance(result, Downloaded) and result.attempts == 5
    os.unlink(result.path)
    assert sleeps == [1, 2, 4, 4]  # base 1, doubling, capped at 4 (rand pinned to 1.0)


def test_retries_are_bounded(osv):
    osv.serve(PATH, Response(status=503))
    with pytest.raises(FetchFailed) as e:
        run(osv)
    assert e.value.attempts == 5 and osv.count(PATH) == 5


def test_retry_after_is_honoured_up_to_the_cap(osv):
    osv.serve(PATH, Response(status=429, headers={"Retry-After": "3"}), Response(body=make_zip()))
    sleeps: list[float] = []
    limits = Limits(read_timeout=1, max_attempts=2, backoff_base=1, backoff_cap=10)
    result = fetch(osv.base_url + PATH, etag=None, limits=limits, sleep=sleeps.append, rand=lambda: 0.0)
    os.unlink(result.path)  # type: ignore[union-attr]
    assert sleeps == [3]


@pytest.mark.parametrize("status", [400, 403, 404])
def test_other_4xx_fail_immediately_without_retry(osv, status):
    osv.serve(PATH, Response(status=status))
    with pytest.raises(FetchFailed) as e:
        run(osv)
    assert e.value.attempts == 1 and osv.count(PATH) == 1 and str(status) in e.value.reason


def test_non_zip_body_is_rejected_and_leaves_no_temp_file(osv, tmp_path):
    osv.serve(PATH, Response(body=b"<html>not a zip</html>"))
    with pytest.raises(FetchFailed, match="not the expected file type"):
        fetch(osv.base_url + PATH, etag=None, limits=FAST, tmp_dir=str(tmp_path), sleep=lambda s: None)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("omit_length", [False, True], ids=["by-content-length", "by-streaming-count"])
def test_oversized_download_is_rejected_and_leaves_no_temp_file(osv, tmp_path, omit_length):
    body = make_zip()
    osv.serve(PATH, Response(body=body, omit_length=omit_length))
    limits = Limits(read_timeout=1, max_bytes=len(body) - 1)
    with pytest.raises(FetchFailed, match="larger than") as e:
        fetch(osv.base_url + PATH, etag=None, limits=limits, tmp_dir=str(tmp_path), sleep=lambda s: None)
    assert e.value.attempts == 1  # not retried
    assert list(tmp_path.iterdir()) == []


def test_slow_response_times_out_and_is_retried(osv):
    osv.serve(PATH, Response(delay=1.0, body=make_zip()))
    limits = Limits(read_timeout=0.2, connect_timeout=1, max_attempts=2)
    with pytest.raises(FetchFailed) as e:
        fetch(osv.base_url + PATH, etag=None, limits=limits, sleep=lambda s: None)
    assert e.value.attempts == 2 and "Timeout" in e.value.reason


def test_truncated_body_is_retried_not_stored(osv, tmp_path):
    osv.serve(PATH, Response(body=make_zip(), truncate=True), Response(body=make_zip()))
    result = fetch(osv.base_url + PATH, etag=None, limits=FAST, tmp_dir=str(tmp_path), sleep=lambda s: None)
    assert isinstance(result, Downloaded) and result.attempts == 2
    os.unlink(result.path)
    assert list(tmp_path.iterdir()) == []


def test_total_timeout_bounds_the_whole_fetch_not_each_attempt(osv):
    # Every attempt dies by read timeout after 0.3s. Five attempts used to be allowed to run for
    # 5 x total_timeout; the budget has to cover all attempts and the sleeps between them.
    import time

    osv.serve(PATH, Response(delay=2.0, body=make_zip()))
    limits = Limits(
        read_timeout=0.3, connect_timeout=1, max_attempts=5, backoff_base=0.1, backoff_cap=0.1, total_timeout=1.0
    )
    started = time.monotonic()
    with pytest.raises(FetchFailed, match="total"):
        fetch(osv.base_url + PATH, etag=None, limits=limits)
    assert time.monotonic() - started < 1.0 + 0.6


def test_json_magic_accepts_a_json_body_and_rejects_a_zip(osv, tmp_path):
    osv.serve(PATH, Response(body=b'{"vulnerabilities": []}'))
    result = fetch(osv.base_url + PATH, etag=None, limits=FAST, tmp_dir=str(tmp_path), magic=b"{")
    assert isinstance(result, Downloaded)
    os.unlink(result.path)

    osv.serve(PATH, Response(body=make_zip()))
    with pytest.raises(FetchFailed, match="not the expected file type"):
        fetch(osv.base_url + PATH, etag=None, limits=FAST, tmp_dir=str(tmp_path), magic=b"{")
