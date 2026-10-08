"""Re-run normalization for one artifact from its raw copy in object storage, without the crawler.

    python -m pipeline.normalize.reprocess <ecosystem> [--source osv] [--sha256 <hex>]

Without --sha256 it takes the newest artifact this normalizer has seen for the ecosystem. After an adapter
version bump the run is new, so every row written by the old adapter is rewritten. For the same adapter
version it only finishes a failed run or re-sends a missing event.
"""

import argparse
import os
import sys
import uuid

from .. import log
from ..storage import make_client
from . import config
from .process import Deps, handle
from .store import Store
from .worker import Publisher


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ecosystem")
    parser.add_argument("--source", default="osv")
    parser.add_argument("--sha256")
    args = parser.parse_args()
    logger = log.setup("normalizer")
    settings = config.load()
    store = Store(settings.database_url)
    sha256 = args.sha256 or store.latest_artifact(args.source, args.ecosystem)
    if not sha256:
        logger.error("no artifact known for this ecosystem; pass --sha256", extra={"ecosystem": args.ecosystem})
        return 1
    deps = Deps(
        store=store,
        s3=make_client(settings.s3_endpoint, settings.s3_access_key, settings.s3_secret_key),
        bucket=settings.s3_bucket,
        publish=Publisher(os.environ.get("NORMALIZER_KAFKA_BOOTSTRAP", "127.0.0.1:19092")).publish,
        limits=settings.limits,
    )
    event = {
        "eventId": str(uuid.uuid4()),
        "type": "artifact.ingested",
        "version": 1,
        "timestamp": "2026-01-01T00:00:00Z",
        "correlationId": f"reprocess-{sha256[:12]}",
        "runId": str(uuid.uuid4()),
        "source": args.source,
        "ecosystem": args.ecosystem,
        "artifact": {
            "bucket": settings.s3_bucket,
            "key": f"raw/{args.source}/{args.ecosystem}/{sha256}.zip",
            "sha256": sha256,
            "sizeBytes": 0,
        },
        "fetchedAt": "2026-01-01T00:00:00Z",
    }
    outcome = handle(event, deps)
    store.close()
    logger.info("reprocess done", extra={"outcome": outcome, "artifactSha256": sha256})
    return 0 if outcome in ("published", "skipped_duplicate") else 1


sys.exit(main())
