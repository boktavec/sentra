import hashlib
import os
import random
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

import httpx

from .config import Limits


class FetchFailed(Exception):
    """The download failed for good: a non-retryable error, or retries were exhausted.

    `transient` says whether trying again later can help (upstream down, rate limited, timeout). It
    defaults to False so an unclassified failure is never retried automatically."""

    def __init__(self, reason: str, attempts: int, transient: bool = False):
        super().__init__(reason)
        self.reason = reason
        self.attempts = attempts
        self.transient = transient


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
    # Paginated sources only (ghsa): the lower bound requested and the newest modification time seen.
    modified_from: datetime | None = None
    watermark: datetime | None = None


@dataclass(frozen=True)
class NotModified:
    attempts: int


def backoff_delay(limits: Limits, attempt: int, rand: Callable[[], float], retry_after: float | None = None) -> float:
    """Exponential backoff with full jitter; a server's Retry-After raises it, up to the cap."""
    delay = rand() * min(limits.backoff_cap, limits.backoff_base * 2 ** (attempt - 1))
    if retry_after is not None:
        delay = max(delay, min(retry_after, limits.backoff_cap))
    return delay


def _once(
    client: httpx.Client, url: str, etag: str | None, limits: Limits, tmp_dir: str | None, deadline: float, magic: bytes
):
    headers = {"If-None-Match": etag} if etag else {}
    remaining = max(deadline - time.monotonic(), 0.001)
    timeout = httpx.Timeout(min(limits.read_timeout, remaining), connect=min(limits.connect_timeout, remaining))
    with client.stream("GET", url, headers=headers, timeout=timeout) as r:
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
        fd, path = tempfile.mkstemp(dir=tmp_dir, suffix=".part")
        try:
            with os.fdopen(fd, "wb") as out:
                for chunk in r.iter_bytes(64 * 1024):
                    size += len(chunk)
                    if size > limits.max_bytes:
                        raise _Fatal(f"artifact larger than {limits.max_bytes} bytes")
                    if time.monotonic() > deadline:
                        raise _Retryable("total download timeout")
                    head = (head + chunk)[: len(magic)]
                    digest.update(chunk)
                    out.write(chunk)
            if not head.startswith(magic):
                raise _Fatal("response is not the expected file type")
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
    magic: bytes = b"PK",  # first bytes the body must start with; ZIP by default
    client: httpx.Client | None = None,
    sleep: Callable[[float], None] = time.sleep,
    rand: Callable[[], float] = random.random,
) -> Downloaded | NotModified:
    """Conditional GET with bounded retries (exponential backoff, full jitter) and a size cap.

    `limits.total_timeout` is one deadline for everything: all attempts plus the sleeps between them.
    """
    deadline = time.monotonic() + limits.total_timeout
    own_client = client is None
    client = client or httpx.Client(follow_redirects=False)
    try:
        for attempt in range(1, limits.max_attempts + 1):
            try:
                result = _once(client, url, etag, limits, tmp_dir, deadline, magic)
            except _Fatal as e:
                raise FetchFailed(str(e), attempt) from e
            except (_Retryable, httpx.TransportError) as e:
                reason = e.args[0] if isinstance(e, _Retryable) else f"{type(e).__name__}"
                if attempt == limits.max_attempts:
                    raise FetchFailed(f"{reason} after {attempt} attempts", attempt, transient=True) from e
                delay = backoff_delay(limits, attempt, rand, e.retry_after if isinstance(e, _Retryable) else None)
                if time.monotonic() + delay >= deadline:
                    raise FetchFailed(
                        f"{reason}; total timeout of {limits.total_timeout:g}s exhausted after {attempt} attempts",
                        attempt,
                        transient=True,
                    ) from e
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
