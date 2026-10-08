import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from . import contracts, events, signing
from .config import Limits
from .fetch import Downloaded, FetchFailed, NotModified, fetch
from .metrics import DOWNLOAD_BYTES, RETRIES
from .runs import Run, Runs
from .storage import ArtifactStore

log = logging.getLogger("crawler")

# Source + ecosystem -> path under the configured base URL. Events never carry URLs.
OSV_ECOSYSTEMS = {"npm": "npm", "PyPI": "PyPI"}


@dataclass
class Deps:
    runs: Runs
    store: ArtifactStore
    publish: Callable[[dict[str, Any]], None]
    signing_keys: dict[str, bytes]
    osv_base_url: str
    limits: Limits = Limits()
    tmp_dir: str | None = None
    fetch_fn: Callable[..., Downloaded | NotModified] = fetch


def _drop(outcome: str, reason: str, event: dict[str, Any]) -> str:
    log.warning("request dropped", extra={"reason": reason, "correlationId": event.get("correlationId")})
    return outcome


def handle(event: dict[str, Any], deps: Deps) -> str:
    """Process one crawl.requested. Returns the outcome:
    dropped_invalid | dropped_signature | dropped_unsupported | skipped | unchanged | published | failed.
    Exceptions (storage, database or broker down) propagate so the caller does not commit the offset."""
    try:
        contracts.validate("crawl.requested", event)
    except contracts.InvalidEvent as e:
        return _drop("dropped_invalid", str(e), event)
    if not signing.verify(event, deps.signing_keys):
        return _drop("dropped_signature", "bad signature or unknown keyId", event)
    if event["source"] != "osv" or event["ecosystem"] not in OSV_ECOSYSTEMS:
        return _drop("dropped_unsupported", f"unsupported {event['source']}/{event['ecosystem']}", event)

    run = deps.runs.claim(
        event["runId"],
        event["source"],
        event["ecosystem"],
        event["correlationId"],
        deps.limits.claim_lease_seconds,
    )
    if run is None:
        log.info(
            "run already finished or in progress",
            extra={"runId": event["runId"], "correlationId": event["correlationId"]},
        )
        return "skipped"
    try:
        return _process(run, deps)
    except BaseException:
        deps.runs.release(run.run_id)  # a redelivery may resume immediately
        raise


def _process(run: Run, deps: Deps) -> str:
    extra = {"runId": run.run_id, "correlationId": run.correlation_id}
    fetched_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")

    if run.status == "fetching":
        url = f"{deps.osv_base_url}/{OSV_ECOSYSTEMS[run.ecosystem]}/all.zip"
        previous = deps.runs.latest_published(run.source, run.ecosystem)
        try:
            result = deps.fetch_fn(
                url,
                etag=previous.etag if previous else None,
                limits=deps.limits,
                tmp_dir=deps.tmp_dir,
            )
        except FetchFailed as e:
            RETRIES.labels(run.source).inc(e.attempts - 1)
            # Publish first, then mark: if we crash in between, the redelivery retries the whole run.
            deps.publish(
                events.crawl_failed(run.run_id, run.correlation_id, run.source, run.ecosystem, e.reason, e.attempts)
            )
            deps.runs.mark_failed(run.run_id, e.reason, e.attempts)
            log.error("ingestion failed", extra={**extra, "reason": e.reason})
            return "failed"

        RETRIES.labels(run.source).inc(result.attempts - 1)
        if isinstance(result, NotModified):
            deps.runs.mark_unchanged(
                run.run_id,
                previous.etag if previous else None,
                previous.sha256 if previous else None,
                previous.size_bytes if previous else None,
                result.attempts,
            )
            log.info("upstream unchanged (304)", extra=extra)
            return "unchanged"

        DOWNLOAD_BYTES.labels(run.source).inc(result.size)
        try:
            if previous and previous.sha256 == result.sha256:
                deps.runs.mark_unchanged(run.run_id, result.etag, result.sha256, result.size, result.attempts)
                log.info("upstream content identical", extra=extra)
                return "unchanged"
            key = deps.store.put(
                result.path,
                run_id=run.run_id,
                source=run.source,
                ecosystem=run.ecosystem,
                sha256=result.sha256,
                size=result.size,
                etag=result.etag,
                source_url=url,
                fetched_at=fetched_at,
            )
        finally:
            os.unlink(result.path)
        deps.runs.mark_stored(run.run_id, key, result.sha256, result.etag, result.size, result.attempts)
        run = Run(
            **{
                **run.__dict__,
                "status": "stored",
                "artifact_key": key,
                "sha256": result.sha256,
                "size_bytes": result.size,
            }
        )

    if not (run.artifact_key and run.sha256 and run.size_bytes is not None):  # the table CHECK prevents this
        raise RuntimeError(f"run {run.run_id} is stored without an artifact")
    deps.publish(
        events.artifact_ingested(
            run.run_id,
            run.correlation_id,
            run.source,
            run.ecosystem,
            deps.store.bucket,
            run.artifact_key,
            run.sha256,
            run.size_bytes,
            fetched_at,
        )
    )
    deps.runs.mark_published(run.run_id)
    log.info("artifact published", extra=extra)
    return "published"
