import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import psycopg
from botocore.exceptions import BotoCoreError, ClientError
from confluent_kafka import KafkaException

from .. import contracts
from . import archive, events, model
from .adapters import osv
from .config import Limits
from .metrics import ARTIFACTS, RECORDS, RETRIES, RUN_SECONDS
from .store import Claim, LeaseLost, Store

log = logging.getLogger("pipeline")

# Source name -> (adapter, adapter version). A source with no entry is skipped until its story adds one.
ADAPTERS: dict[str, tuple[Callable[[dict[str, Any]], dict[str, Any]], int]] = {
    osv.SOURCE: (osv.normalize, osv.ADAPTER_VERSION),
}

# Failures of something we depend on. These are released and retried for as long as the outage lasts,
# so an outage is never mistaken for a bad artifact.
TRANSIENT = (OSError, KafkaException, psycopg.OperationalError, psycopg.InterfaceError, BotoCoreError, ClientError)


class Busy(Exception):
    """Another worker holds the run. The event is redelivered after a pause."""


class TooManyFailures(Exception):
    pass


@dataclass
class Deps:
    store: Store
    s3: Any
    bucket: str
    publish: Callable[[dict[str, Any]], None]
    limits: Limits = field(default_factory=Limits)
    sleep: Callable[[float], None] = time.sleep


def _pass(run_id: str, event: dict[str, Any], deps: Deps) -> None:
    """One streaming pass over the artifact: normalize, validate, write in batches, quarantine the rest."""
    limits, sha256, source = deps.limits, event["artifact"]["sha256"], event["source"]
    normalize, adapter_version = ADAPTERS[source]
    deps.store.restart(run_id, limits.lease_seconds)
    ok: list[tuple[str, dict[str, Any]]] = []
    failed: list[tuple[str, str]] = []
    seen = bad = 0

    def flush() -> None:
        upserted, unchanged = deps.store.commit_batch(
            run_id,
            sha256=sha256,
            adapter_version=adapter_version,
            schema_version=model.SCHEMA_VERSION,
            ok=ok,
            failed=failed,
            lease_seconds=limits.lease_seconds,
        )
        RECORDS.labels("upserted").inc(upserted)
        RECORDS.labels("unchanged").inc(unchanged)
        RECORDS.labels("quarantined").inc(len(failed))
        ok.clear()
        failed.clear()

    with archive.download(deps.s3, deps.bucket, event["artifact"]["key"], sha256, limits.max_artifact_bytes) as f:
        for entry in archive.entries(f, limits):
            seen += 1
            try:
                if entry.error:
                    raise ValueError(entry.error)
                doc = normalize(entry.record)
                model.validate(doc)
                ok.append((entry.name, doc))
            except Exception as e:  # a bad record is quarantined, whatever way it is bad
                bad += 1
                failed.append((entry.name, f"{type(e).__name__}: {e}"[:1000]))
            too_many = seen >= limits.min_records_for_rate and bad / seen > limits.max_failure_rate
            if len(ok) + len(failed) >= limits.batch_size or too_many:
                flush()
            if too_many:
                raise TooManyFailures(f"{bad} of {seen} records failed (limit {limits.max_failure_rate:.0%})")
        flush()


def _run(claim: Claim, event: dict[str, Any], deps: Deps, extra: dict[str, Any]) -> str:
    """Process a claimed run. Returns completed or failed; raises if it must be retried."""
    run_id, limits = claim.run_id, deps.limits
    for attempt in range(1, limits.max_attempts + 1):
        try:
            _pass(run_id, event, deps)
        except LeaseLost:
            return "skipped_duplicate"
        except (archive.ArchiveError, TooManyFailures) as e:
            deps.store.finish(run_id, status="failed", error=str(e)[:500])
            log.error("artifact failed", extra={**extra, "reason": str(e)})
            return "failed"
        except TRANSIENT as e:
            try:  # release the run so the redelivered event can retake it at once
                deps.store.finish(run_id, status="failed", error=f"{type(e).__name__}: {e}"[:500])
            except Exception:  # noqa: S110 - the lease expiring is the fallback
                pass
            raise
        except Exception as e:
            log.warning("attempt failed", extra={**extra, "reason": f"{type(e).__name__}: {e}"})
            if attempt == limits.max_attempts:
                deps.store.finish(run_id, status="failed", error=f"processing_failed: {type(e).__name__}: {e}"[:500])
                return "failed"
            RETRIES.inc()
            deps.sleep(min(limits.backoff_base * 2 ** (attempt - 1), limits.backoff_cap))
        else:
            return "completed" if deps.store.finish(run_id, status="completed") else "skipped_duplicate"
    return "failed"  # unreachable: the last attempt returns or raises


def _announce(run_id: str, event: dict[str, Any], deps: Deps) -> None:
    """Send vulnerabilities.normalized for a completed run. The eventId is fixed per run, so a resend dedupes."""
    run = deps.store.run(run_id)
    _, adapter_version = ADAPTERS[event["source"]]
    deps.publish(
        events.vulnerabilities_normalized(
            run_id,
            run.correlation_id,
            event["source"],
            event["ecosystem"],
            event["artifact"]["sha256"],
            adapter_version,
            run.upserted,
            run.unchanged,
            run.quarantined,
        )
    )
    deps.store.mark_published(run_id)


def handle(event: dict[str, Any], deps: Deps) -> str:
    """Process one artifact.ingested. Returns the outcome:
    dropped_invalid | dropped_untrusted | skipped_source | skipped_duplicate | published | failed.
    Exceptions escape for outages and a busy run, so the caller does not commit the offset and the event
    is redelivered."""
    try:
        contracts.validate("artifact.ingested", event)
    except contracts.InvalidEvent as e:
        log.warning("event dropped", extra={"outcome": "dropped_invalid", "reason": str(e)})
        return "dropped_invalid"
    source, ecosystem, artifact = event["source"], event["ecosystem"], event["artifact"]
    extra = {"correlationId": event["correlationId"], "artifactSha256": artifact["sha256"], "ecosystem": ecosystem}
    if source not in ADAPTERS:
        log.info("source has no adapter yet", extra={**extra, "outcome": "skipped_source"})
        return "skipped_source"
    # The crawler's layout is the only place the pipeline will read from, whatever the event says.
    if artifact["key"] != f"raw/{source}/{ecosystem}/{artifact['sha256']}.zip":
        log.warning("event dropped", extra={**extra, "outcome": "dropped_untrusted", "reason": "unexpected object key"})
        return "dropped_untrusted"
    _, adapter_version = ADAPTERS[source]
    started = time.monotonic()
    claim = deps.store.claim(
        sha256=artifact["sha256"],
        source=source,
        ecosystem=ecosystem,
        adapter_version=adapter_version,
        correlation_id=event["correlationId"],
        lease_seconds=deps.limits.lease_seconds,
    )
    if claim.state == "busy":
        raise Busy(claim.run_id)
    if claim.state == "published":
        return "skipped_duplicate"
    outcome = "completed" if claim.state == "completed" else _run(claim, event, deps, extra)
    if outcome == "completed":
        _announce(claim.run_id, event, deps)
        outcome = "published"
    RUN_SECONDS.observe(time.monotonic() - started)
    log.info("artifact handled", extra={**extra, "outcome": outcome})
    return outcome


def handled(event: dict[str, Any], deps: Deps) -> str:
    outcome = handle(event, deps)
    ARTIFACTS.labels(outcome).inc()
    return outcome
