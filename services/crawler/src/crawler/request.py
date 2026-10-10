"""Publish one signed crawl.requested by hand. The scheduler (crawler.scheduler) builds its requests with build().

    python -m crawler.request <source> <ecosystem>     e.g. cisa-kev none, osv npm, ghsa none

Signs with the first key in CRAWLER_SIGNING_KEYS. Prints the runId, which is the row in ingestion_runs.
"""

import json
import os
import sys
import uuid
from datetime import UTC, datetime

from confluent_kafka import KafkaException, Producer

from . import config, contracts, signing


def build(
    source: str,
    ecosystem: str,
    keys: dict[str, bytes],
    run_id: str | None = None,
    correlation_id: str | None = None,
) -> dict:
    key_id, secret = next(iter(keys.items()))
    run_id = run_id or str(uuid.uuid4())
    event = {
        "eventId": str(uuid.uuid4()),
        "type": "crawl.requested",
        "version": 1,
        "timestamp": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "correlationId": correlation_id or f"manual-{run_id[:8]}",
        "runId": run_id,
        "source": source,
        "ecosystem": ecosystem,
        "keyId": key_id,
    }
    event["signature"] = signing.sign(event, secret)
    contracts.validate("crawl.requested", event)
    return event


def publish(producer: Producer, event: dict, topic: str = "crawl.requested") -> None:
    """Produce the request and wait for the broker's acknowledgement; raise if it does not come."""
    error: list[KafkaException] = []

    def delivered(err: object, _msg: object) -> None:
        if err is not None:
            error.append(KafkaException(err))

    producer.produce(topic, key=event["runId"], value=json.dumps(event).encode(), on_delivery=delivered)
    if producer.flush(30) > 0:
        raise TimeoutError("broker did not acknowledge the request in 30s")
    if error:
        raise error[0]


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    event = build(sys.argv[1], sys.argv[2], config.parse_signing_keys(config._required("CRAWLER_SIGNING_KEYS")))
    producer = Producer({"bootstrap.servers": os.environ.get("CRAWLER_KAFKA_BOOTSTRAP", "127.0.0.1:19092")})
    try:
        publish(producer, event)
    except (TimeoutError, KafkaException) as e:
        print(f"request not published: {e}", file=sys.stderr)
        return 1
    print(event["runId"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
