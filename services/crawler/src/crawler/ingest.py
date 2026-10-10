import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from . import contracts, events, ghsa, signing
from .config import Limits, Secret, Settings
from .fetch import Downloaded, FetchFailed, NotModified, fetch
from .metrics import DOWNLOAD_BYTES, RETRIES
from .runs import Run, Runs
from .storage import ArtifactStore

log = logging.getLogger("crawler")

# Source + ecosystem -> path under the configured base URL. Events never carry URLs.
OSV_ECOSYSTEMS = {"npm": "npm", "PyPI": "PyPI"}
KEV = ("cisa-kev", "none")  # one global catalog, so no ecosystem; contracts require a non-empty value
GHSA = ("ghsa", "none")  # one global advisory database, so no ecosystem


@dataclass(frozen=True)
class Target:
    url: str
    ext: str  # artifact suffix
    magic: bytes  # the body must start with these bytes


@dataclass
class Deps:
    runs: Runs
    store: ArtifactStore
    publish: Callable[[dict[str, Any]], None]
    signing_keys: dict[str, bytes]
    osv_base_url: str
    kev_url: str = Settings.kev_url
    limits: Limits = Limits()
    tmp_dir: str | None = None
    fetch_fn: Callable[..., Downloaded | NotModified] = fetch
    github_token: Secret | None = None
    github_base_url: str = ghsa.GITHUB_API  # only tests point this elsewhere; it is not operator config
    ghsa_fn: Callable[..., Downloaded | NotModified] = ghsa.fetch_advisories


def target(source: str, ecosystem: str, deps: Deps) -> Target | None:
    if source == "osv" and ecosystem in OSV_ECOSYSTEMS:
        return Target(f"{deps.osv_base_url}/{OSV_ECOSYSTEMS[ecosystem]}/all.zip", "zip", b"PK")
    if (source, ecosystem) == KEV:
        return Target(deps.kev_url, "json", b"{")
    if (source, ecosystem) == GHSA:
        return Target(f"{deps.github_base_url}/advisories", "zip", b"PK")
    return None


def _drop(outcome: str, reason: str, event: dict[str, Any]) -> str:
    log.warning("request dropped", extra={"reason": reason, "correlationId": event.get("correlationId")})
    return outcome


def handle(event: dict[str, Any], deps: Deps) -> str:
    """Process one crawl.requested. Returns the outcome:
    dropped_invalid | dropped_signature | dropped_unsupported | skipped | unchanged | published | failed | rate_limited.
    Exceptions (storage, database or broker down) propagate so the caller does not commit the offset."""
    try:
        contracts.validate("crawl.requested", event)
    except (contracts.InvalidEvent, RecursionError) as e:  # RecursionError: absurdly nested field values
        return _drop("dropped_invalid", str(e)[:300], event)
    if not signing.verify(event, deps.signing_keys):
        return _drop("dropped_signature", "bad signature or unknown keyId", event)
    if target(event["source"], event["ecosystem"], deps) is None:
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
        try:
            deps.runs.release(run.run_id)  # a redelivery may resume immediately
        except Exception:  # noqa: BLE001 - the original error matters more; the lease simply lapses
            log.warning("could not release the claim; it will lapse", extra={"runId": run.run_id})
        raise


def _download(t: Target, run: Run, previous: Run | None, deps: Deps) -> Downloaded | NotModified:
    if (run.source, run.ecosystem) == GHSA:
        return deps.ghsa_fn(
            deps.github_token,
            since=previous.watermark if previous else None,
            limits=deps.limits,
            tmp_dir=deps.tmp_dir,
            base_url=deps.github_base_url,
        )
    return deps.fetch_fn(
        t.url, etag=previous.etag if previous else None, limits=deps.limits, tmp_dir=deps.tmp_dir, magic=t.magic
    )


def _bundle_meta(result: Downloaded) -> dict[str, Any]:
    """What the meta sidecar records about a GHSA bundle: its layout and the request window. No credentials."""
    since = result.modified_from
    return {
        "bundleFormat": ghsa.BUNDLE_FORMAT,
        "modifiedFrom": since.isoformat(timespec="seconds").replace("+00:00", "Z") if since else None,
    }


def _process(run: Run, deps: Deps) -> str:
    extra = {"runId": run.run_id, "correlationId": run.correlation_id}
    fetched_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")

    if run.status == "fetching":
        t = target(run.source, run.ecosystem, deps)
        if t is None:  # claimed runs were validated on request; config may have changed since
            raise RuntimeError(f"unsupported {run.source}/{run.ecosystem}")
        previous = deps.runs.latest_published(run.source, run.ecosystem)
        try:
            result = _download(t, run, previous, deps)
        except FetchFailed as e:
            RETRIES.labels(run.source).inc(max(e.attempts - 1, 0))
            # Publish first, then mark: if we crash in between, the redelivery retries the whole run.
            kind = "transient" if e.transient else "permanent"
            deps.publish(
                events.crawl_failed(
                    run.run_id, run.correlation_id, run.source, run.ecosystem, e.reason, e.attempts, kind
                )
            )
            deps.runs.mark_failed(run.run_id, e.reason, e.attempts, kind)
            log.error("ingestion failed", extra={**extra, "reason": e.reason})
            return "rate_limited" if isinstance(e, ghsa.RateLimited) else "failed"

        RETRIES.labels(run.source).inc(result.attempts - 1)
        if isinstance(result, NotModified):
            deps.runs.mark_unchanged(
                run.run_id,
                previous.etag if previous else None,
                previous.sha256 if previous else None,
                previous.size_bytes if previous else None,
                result.attempts,
                previous.watermark if previous else None,
            )
            log.info("upstream unchanged (304)", extra=extra)
            return "unchanged"

        DOWNLOAD_BYTES.labels(run.source).inc(result.size)
        try:
            if previous and previous.sha256 == result.sha256:
                deps.runs.mark_unchanged(
                    run.run_id, result.etag, result.sha256, result.size, result.attempts, result.watermark
                )
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
                source_url=t.url,
                ext=t.ext,
                fetched_at=fetched_at,
                extra_meta=_bundle_meta(result) if run.source == GHSA[0] else None,
            )
        finally:
            os.unlink(result.path)
        deps.runs.mark_stored(
            run.run_id, key, result.sha256, result.etag, result.size, result.attempts, result.watermark
        )
        run = Run(
            **{
                **run.__dict__,
                "status": "stored",
                "artifact_key": key,
                "sha256": result.sha256,
                "size_bytes": result.size,
                "watermark": result.watermark,
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
