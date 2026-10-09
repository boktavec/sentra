"""Publish one signed crawl.requested by hand, until SENTRA-10 schedules requests.

    python -m crawler.request <source> <ecosystem>     e.g. cisa-kev none, osv npm

Signs with the first key in CRAWLER_SIGNING_KEYS. Prints the runId, which is the row in ingestion_runs.
"""

import json
import os
import sys
import uuid
from datetime import UTC, datetime

from confluent_kafka import Producer

from . import config, contracts, signing


def build(source: str, ecosystem: str, keys: dict[str, bytes]) -> dict:
    key_id, secret = next(iter(keys.items()))
    run_id = str(uuid.uuid4())
    event = {
        "eventId": str(uuid.uuid4()),
        "type": "crawl.requested",
        "version": 1,
        "timestamp": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "correlationId": f"manual-{run_id[:8]}",
        "runId": run_id,
        "source": source,
        "ecosystem": ecosystem,
        "keyId": key_id,
    }
    event["signature"] = signing.sign(event, secret)
    contracts.validate("crawl.requested", event)
    return event


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    event = build(sys.argv[1], sys.argv[2], config.parse_signing_keys(config._required("CRAWLER_SIGNING_KEYS")))
    producer = Producer({"bootstrap.servers": os.environ.get("CRAWLER_KAFKA_BOOTSTRAP", "127.0.0.1:19092")})
    producer.produce("crawl.requested", key=event["runId"], value=json.dumps(event).encode())
    if producer.flush(30) > 0:
        print("broker did not acknowledge the request in 30s", file=sys.stderr)
        return 1
    print(event["runId"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
