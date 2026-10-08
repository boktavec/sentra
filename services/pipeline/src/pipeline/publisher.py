import json
from typing import Any

from confluent_kafka import KafkaException, Producer


class Publisher:
    """Synchronous Kafka producer: publish() returns only once the broker acknowledged, else raises.

    The topic is the event type; `key_field` names the event field used as the partition key.
    """

    def __init__(self, bootstrap: str, key_field: str):
        self.key_field = key_field
        self.producer = Producer({"bootstrap.servers": bootstrap, "enable.idempotence": True, "acks": "all"})

    def publish(self, event: dict[str, Any]) -> None:
        error: list[Exception] = []

        def done(err: Any, _msg: Any) -> None:
            if err is not None:
                error.append(KafkaException(err))

        self.producer.produce(
            event["type"], key=event[self.key_field], value=json.dumps(event).encode(), on_delivery=done
        )
        if self.producer.flush(30) > 0:
            raise TimeoutError("broker did not acknowledge the event in 30s")
        if error:
            raise error[0]
