from dataclasses import dataclass
from typing import Any

import boto3
from botocore.config import Config


def make_client(endpoint: str, access_key: str, secret_key: str) -> Any:
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 3, "mode": "standard"}),
    )


@dataclass(frozen=True)
class Fetched:
    """`data` is None when the object is over the limit; `size` is then its stored size if known."""

    data: bytes | None
    size: int | None


def read_capped(s3: Any, bucket: str, key: str, max_bytes: int) -> Fetched:
    """Read an object without ever holding more than max_bytes + 1 of it in memory."""
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"]
    try:
        length = obj.get("ContentLength")
        if length is not None and length > max_bytes:
            return Fetched(None, length)
        data = body.read(max_bytes + 1)
    finally:
        body.close()
    if len(data) > max_bytes:
        return Fetched(None, None)
    return Fetched(data, len(data))
