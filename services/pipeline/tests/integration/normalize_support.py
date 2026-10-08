"""Helpers for the normalizer integration tests: real OSV records, zips built from them, and an Env wrapper."""

import hashlib
import io
import json
import uuid
import zipfile
from dataclasses import replace
from pathlib import Path
from typing import Any

import psycopg

from pipeline.normalize.config import Limits
from pipeline.normalize.process import Deps
from pipeline.normalize.store import Store

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "osv"
GOOD = ["ecosystem_pysec", "semver_fixed", "versions_only", "malware", "withdrawn", "git"]
ECOSYSTEM = "PyPI"


def record(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def make_zip(entries: dict[str, dict[str, Any] | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, body in entries.items():
            zf.writestr(name, body if isinstance(body, bytes) else json.dumps(body))
    return buf.getvalue()


def good_entries() -> dict[str, dict[str, Any] | bytes]:
    return {f"{record(n)['id']}.json": record(n) for n in GOOD}


class Flaky:
    """The real S3 client, except the first `fail` get_object calls raise (a storage outage)."""

    def __init__(self, s3: Any):
        self._s3, self.fail = s3, 0

    def get_object(self, **kwargs: Any) -> Any:
        if self.fail:
            self.fail -= 1
            raise ConnectionError("storage unavailable")
        return self._s3.get_object(**kwargs)


class Env:
    def __init__(self, database, bucket):
        self.admin_url, _, self.normalizer_url = database
        self.s3, self.bucket = bucket
        self.flaky = Flaky(self.s3)
        self.published: list[dict[str, Any]] = []
        self.publish_fails = 0
        self.limits = Limits(batch_size=2, max_attempts=3, backoff_base=0.001, backoff_cap=0.002)
        self.stores: list[Store] = []

    def _publish(self, event: dict[str, Any]) -> None:
        if self.publish_fails:
            self.publish_fails -= 1
            raise ConnectionError("broker unavailable")
        self.published.append(event)

    def deps(self, **limits: Any) -> Deps:
        store = Store(self.normalizer_url)
        self.stores.append(store)
        merged = replace(self.limits, **limits)
        return Deps(
            store=store, s3=self.flaky, bucket=self.bucket, publish=self._publish, limits=merged, sleep=lambda _: None
        )

    def upload(self, entries: dict[str, dict[str, Any] | bytes] | bytes) -> tuple[bytes, str]:
        data = entries if isinstance(entries, bytes) else make_zip(entries)
        sha = hashlib.sha256(data).hexdigest()
        self.s3.put_object(Bucket=self.bucket, Key=f"raw/osv/{ECOSYSTEM}/{sha}.zip", Body=data)
        return data, sha

    def event(self, sha: str, **over: Any) -> dict[str, Any]:
        event = {
            "eventId": str(uuid.uuid4()),
            "type": "artifact.ingested",
            "version": 1,
            "timestamp": "2026-10-08T09:00:00Z",
            "correlationId": "it-corr-1",
            "runId": str(uuid.uuid4()),
            "source": "osv",
            "ecosystem": ECOSYSTEM,
            "artifact": {"bucket": self.bucket, "key": f"raw/osv/{ECOSYSTEM}/{sha}.zip", "sha256": sha, "sizeBytes": 1},
            "fetchedAt": "2026-10-08T09:00:00Z",
        }
        return {**event, **over}

    def q(self, query: str, *args: Any) -> list[tuple[Any, ...]]:
        with psycopg.connect(self.admin_url, autocommit=True) as conn:
            cur = conn.execute(query, args)  # type: ignore[arg-type]
            return cur.fetchall() if cur.description else []

    def run(self, sha: str) -> dict[str, Any]:
        (row,) = self.q(
            "SELECT status, upserted, unchanged, quarantined, error FROM normalization_runs WHERE artifact_sha256 = %s",
            sha,
        )
        return dict(zip(("status", "upserted", "unchanged", "quarantined", "error"), row, strict=True))
