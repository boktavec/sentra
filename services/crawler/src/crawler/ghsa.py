"""GitHub global security advisories (REST `GET /advisories`, reviewed only), fetched page by page.

The raw page bodies are stored unmodified, one zip entry per page, in a deterministic zip (fixed entry
timestamps), so the same upstream content always hashes the same. The token goes only to the configured
API origin: a pagination link that points anywhere else fails the run instead of being followed.
"""

import hashlib
import json
import logging
import os
import random
import tempfile
import time
import zipfile
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode, urlsplit

import httpx

from .config import Limits, Secret, check_source_url
from .fetch import Downloaded, FetchFailed, NotModified, backoff_delay
from .metrics import GITHUB_PAGES, GITHUB_RATE_LIMIT_REMAINING, GITHUB_RATE_LIMIT_WAIT

log = logging.getLogger("crawler")

GITHUB_API = "https://api.github.com"
PAGE_SIZE = 100  # the API maximum
# Incremental runs ask for `modified >= watermark - OVERLAP`, so an advisory that changed while the previous
# run was paginating is fetched again. Re-fetched advisories are harmless: the normalizer only rewrites a
# row when the source's `updated_at` is newer. An assumption, not measured.
OVERLAP = timedelta(hours=1)
# GitHub: a rate-limit response with neither Retry-After nor an exhausted x-ratelimit-remaining means
# "wait at least a minute" (secondary limit).
SECONDARY_LIMIT_WAIT = 60.0
# A page is one zip entry, and the normalizer rejects entries over its `max_entry_bytes` (10 MiB), so the cap
# must not exceed that. Real pages are about 0.7 MB.
MAX_PAGE_BYTES = 10 * 1024**2
BUNDLE_FORMAT = "github-advisory-pages-zip"  # recorded in the artifact's meta sidecar
_ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)  # zip's earliest timestamp: keeps the bundle's bytes reproducible


class RateLimited(FetchFailed):
    """GitHub asked us to wait longer than the run has left. Retryable later; the watermark is unchanged."""


def _timestamp(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def first_url(base: str, since: datetime | None) -> str:
    params = {"type": "reviewed", "per_page": PAGE_SIZE, "sort": "updated", "direction": "asc"}
    if since is not None:
        params["modified"] = f">={_timestamp(since - OVERLAP)}"
    return f"{base}/advisories?{urlencode(params)}"


def _same_origin(url: str, base: str) -> bool:
    a, b = urlsplit(url), urlsplit(base)
    return (a.scheme, a.netloc) == (b.scheme, b.netloc)


class _Pager:
    """GET with the token, bounded retries and rate-limit pacing, all inside one run deadline."""

    def __init__(
        self,
        client: httpx.Client,
        token: Secret,
        limits: Limits,
        deadline: float,
        sleep: Callable[[float], None],
        rand: Callable[[], float],
        now: Callable[[], float],
    ):
        self.client, self.limits, self.deadline = client, limits, deadline
        self.sleep, self.rand, self.now = sleep, rand, now
        self.headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "sentra-crawler",
            "Authorization": f"Bearer {token.reveal()}",
        }
        self.retries = 0

    def pause(self, seconds: float) -> None:
        """Sleep through a rate limit if the run has time for it; otherwise give up as `rate_limited`."""
        if time.monotonic() + seconds >= self.deadline:
            raise RateLimited(
                f"rate limited for {seconds:.0f}s, more than the run has left", 1 + self.retries, transient=True
            )
        log.info("github rate limit: waiting", extra={"waitSeconds": round(seconds)})
        self.sleep(seconds)
        GITHUB_RATE_LIMIT_WAIT.inc(seconds)

    def until_reset(self, headers: httpx.Headers) -> float:
        reset = headers.get("x-ratelimit-reset", "")
        return max(float(reset) - self.now(), 0.0) + 1.0 if reset.isdigit() else SECONDARY_LIMIT_WAIT

    def _limit_wait(self, r: httpx.Response) -> float | None:
        """How long GitHub wants us to wait after a 403/429, or None when it is not a rate limit."""
        retry_after = r.headers.get("retry-after", "")
        if retry_after.isdigit():
            return max(float(retry_after), 1.0)
        if r.headers.get("x-ratelimit-remaining") == "0":
            return self.until_reset(r.headers)
        if r.status_code == 429 or "rate limit" in r.text.lower():
            return SECONDARY_LIMIT_WAIT
        return None

    def _once(self, url: str) -> httpx.Response:
        remaining = max(self.deadline - time.monotonic(), 0.001)
        timeout = httpx.Timeout(
            min(self.limits.read_timeout, remaining), connect=min(self.limits.connect_timeout, remaining)
        )
        return self.client.get(url, headers=self.headers, timeout=timeout)

    def get(self, url: str) -> httpx.Response:
        attempt = 1
        while True:
            try:
                r = self._once(url)
            except httpx.TransportError as e:
                reason = type(e).__name__  # never str(e): it could echo request details
            else:
                if "x-ratelimit-remaining" in r.headers and r.headers["x-ratelimit-remaining"].isdigit():
                    GITHUB_RATE_LIMIT_REMAINING.set(int(r.headers["x-ratelimit-remaining"]))
                if r.status_code == 200:
                    return r
                if r.status_code in (403, 429) and (wait := self._limit_wait(r)) is not None:
                    self.pause(wait)  # waiting out a limit is not a failed attempt
                    continue
                if r.status_code < 500:
                    raise FetchFailed(f"http {r.status_code}", attempt + self.retries)
                reason = f"http {r.status_code}"
            if attempt == self.limits.max_attempts:
                raise FetchFailed(f"{reason} after {attempt} attempts", attempt + self.retries, transient=True)
            delay = backoff_delay(self.limits, attempt, self.rand)
            if time.monotonic() + delay >= self.deadline:
                raise FetchFailed(
                    f"{reason}; total timeout exhausted after {attempt} attempts",
                    attempt + self.retries,
                    transient=True,
                )
            self.sleep(delay)
            attempt += 1
            self.retries += 1


def _updated_at(advisory: object, page: int) -> datetime:
    value = advisory.get("updated_at") if isinstance(advisory, dict) else None
    try:
        parsed = datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        parsed = None
    if parsed is None or parsed.tzinfo is None:
        raise FetchFailed(f"page {page}: an advisory has no valid updated_at", 1)
    return parsed


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_advisories(
    token: Secret | None,
    *,
    since: datetime | None,
    limits: Limits,
    tmp_dir: str | None = None,
    base_url: str = GITHUB_API,
    client: httpx.Client | None = None,
    sleep: Callable[[float], None] = time.sleep,
    rand: Callable[[], float] = random.random,
    now: Callable[[], float] = time.time,
) -> Downloaded | NotModified:
    """Download every reviewed advisory modified since the watermark (all of them when `since` is None).

    Returns NotModified when nothing is newer than `since`. Any failure leaves no temp file behind, and
    nothing is stored by this function, so the caller's watermark only moves on success.
    """
    if token is None:
        raise FetchFailed("CRAWLER_GITHUB_TOKEN is not set; ghsa runs need a token", 0)
    if limits.total_timeout >= OVERLAP.total_seconds():  # a run longer than the overlap could outrun its safety net
        raise RuntimeError("Limits.total_timeout must stay below ghsa.OVERLAP")
    base = check_source_url(base_url)
    deadline = time.monotonic() + limits.total_timeout
    own_client = client is None
    client = client or httpx.Client(follow_redirects=False)
    pager = _Pager(client, token, limits, deadline, sleep, rand, now)
    fd, path = tempfile.mkstemp(dir=tmp_dir, suffix=".part")
    os.close(fd)
    try:
        newest, advisories = _download_pages(pager, base, since, limits, path)
        if advisories == 0 and since is None:
            raise FetchFailed("a full run returned no advisories", 1 + pager.retries)
        if newest is None or (since is not None and newest <= since):
            os.unlink(path)
            return NotModified(1 + pager.retries)
        return Downloaded(
            path,
            _sha256(path),
            os.path.getsize(path),
            None,
            1 + pager.retries,
            modified_from=since - OVERLAP if since else None,
            watermark=newest,
        )
    except BaseException:
        if os.path.exists(path):
            os.unlink(path)
        raise
    finally:
        if own_client:
            client.close()


def _download_pages(
    pager: _Pager, base: str, since: datetime | None, limits: Limits, path: str
) -> tuple[datetime | None, int]:
    """Write each page body, unmodified, into the zip at `path`. Returns (newest updated_at, advisory count)."""
    url: str | None = first_url(base, since)
    seen = {url}
    newest: datetime | None = None
    advisories = raw_bytes = page = 0
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as bundle:
        while url:
            r = pager.get(url)
            page += 1
            GITHUB_PAGES.inc()
            # The whole page is buffered before the cap is checked: acceptable for api.github.com, whose pages are
            # at most PAGE_SIZE advisories, but not a defence against a hostile origin.
            body = r.content
            raw_bytes += len(body)
            if len(body) > MAX_PAGE_BYTES or raw_bytes > limits.max_bytes:
                raise FetchFailed(f"page {page} or the run is larger than the size limit", 1 + pager.retries)
            try:
                items = json.loads(body)
            except ValueError as e:
                raise FetchFailed(f"page {page} is not valid JSON", 1 + pager.retries) from e
            if not isinstance(items, list):
                raise FetchFailed(f"page {page} is not a JSON array", 1 + pager.retries)
            for item in items:
                updated = _updated_at(item, page)
                newest = updated if newest is None or updated > newest else newest
            advisories += len(items)
            if items:
                bundle.writestr(zipfile.ZipInfo(f"page-{page:05d}.json", _ZIP_EPOCH), body, zipfile.ZIP_DEFLATED)
            url = r.links.get("next", {}).get("url")
            if url is None:
                break
            if not _same_origin(url, base):
                raise FetchFailed("pagination link points outside the GitHub API", 1 + pager.retries)
            if url in seen:
                raise FetchFailed("pagination link repeats", 1 + pager.retries)
            seen.add(url)
            if r.headers.get("x-ratelimit-remaining") == "0":
                pager.pause(pager.until_reset(r.headers))  # pace instead of provoking a 403
    return newest, advisories
