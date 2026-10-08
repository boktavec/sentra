import hashlib
import os
import random
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from .config import Limits


class FetchFailed(Exception):
    """The download failed for good: a non-retryable error, or retries were exhausted."""

    def __init__(self, reason: str, attempts: int):
        super().__init__(reason)
        self.reason = reason
        self.attempts = attempts


class _Retryable(Exception):
    def __init__(self, reason: str, retry_after: float | None = None):
        super().__init__(reason)
        self.retry_after = retry_after


class _Fatal(Exception):
    pass


@dataclass(frozen=True)
class Downloaded:
    path: str  # temp file; the caller must delete it
    sha256: str
    size: int
    etag: str | None
    attempts: int


@dataclass(frozen=True)
class NotModified:
    attempts: int


def _once(client: httpx.Client, url: str, etag: str | None, limits: Limits, tmp_dir: str | None):
    headers = {"If-None-Match": etag} if etag else {}
    started = time.monotonic()
    with client.stream("GET", url, headers=headers) as r:
        if r.status_code == 304:
            return None
        if r.status_code == 429 or r.status_code >= 500:
            retry_after = r.headers.get("retry-after", "")
            raise _Retryable(f"http {r.status_code}", float(retry_after) if retry_after.isdigit() else None)
        if r.status_code != 200:
            raise _Fatal(f"http {r.status_code}")
        declared = r.headers.get("content-length")
        if declared and int(declared) > limits.max_bytes:
            raise _Fatal(f"artifact larger than {limits.max_bytes} bytes")

        digest, size, head = hashlib.sha256(), 0, b""
        fd, path = tempfile.mkstemp(dir=tmp_dir, suffix=".zip")
        try:
            with os.fdopen(fd, "wb") as out:
                for chunk in r.iter_bytes(64 * 1024):
                    size += len(chunk)
                    if size > limits.max_bytes:
                        raise _Fatal(f"artifact larger than {limits.max_bytes} bytes")
                    if time.monotonic() - started > limits.total_timeout:
                        raise _Retryable("total download timeout")
                    head = (head + chunk)[:4]
                    digest.update(chunk)
                    out.write(chunk)
            if not head.startswith(b"PK"):
                raise _Fatal("response is not a ZIP archive")
        except BaseException:
            os.unlink(path)
            raise
        return path, digest.hexdigest(), size, r.headers.get("etag")


def fetch(
    url: str,
    *,
    etag: str | None,
    limits: Limits,
    tmp_dir: str | None = None,
    client: httpx.Client | None = None,
    sleep: Callable[[float], None] = time.sleep,
    rand: Callable[[], float] = random.random,
) -> Downloaded | NotModified:
    """Conditional GET with bounded retries (exponential backoff, full jitter) and a size cap."""
    timeout = httpx.Timeout(limits.read_timeout, connect=limits.connect_timeout)
    own_client = client is None
    client = client or httpx.Client(timeout=timeout, follow_redirects=False)
    try:
        for attempt in range(1, limits.max_attempts + 1):
            try:
                result = _once(client, url, etag, limits, tmp_dir)
            except _Fatal as e:
                raise FetchFailed(str(e), attempt) from e
            except (_Retryable, httpx.TransportError) as e:
                reason = e.args[0] if isinstance(e, _Retryable) else f"{type(e).__name__}"
                if attempt == limits.max_attempts:
                    raise FetchFailed(f"{reason} after {attempt} attempts", attempt) from e
                delay = rand() * min(limits.backoff_cap, limits.backoff_base * 2 ** (attempt - 1))
                if isinstance(e, _Retryable) and e.retry_after is not None:
                    delay = max(delay, min(e.retry_after, limits.backoff_cap))
                sleep(delay)
                continue
            if result is None:
                return NotModified(attempt)
            path, sha256, size, new_etag = result
            return Downloaded(path, sha256, size, new_etag, attempt)
        raise AssertionError("unreachable")  # max_attempts >= 1
    finally:
        if own_client:
            client.close()
