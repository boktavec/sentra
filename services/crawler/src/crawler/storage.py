import json
from typing import Any

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import ClientError

# 8 MiB parts; the 208 MiB npm dump uploads as multipart without holding it in memory.
_TRANSFER = TransferConfig(multipart_threshold=8 * 1024 * 1024, multipart_chunksize=8 * 1024 * 1024)


def make_client(endpoint: str, access_key: str, secret_key: str) -> Any:
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 3, "mode": "standard"}),
    )


class ArtifactStore:
    """Content-addressed raw artifacts: raw/<source>/<ecosystem>/<sha256>.zip plus a JSON sidecar."""

    def __init__(self, s3: Any, bucket: str):
        self.s3, self.bucket = s3, bucket

    def key(self, source: str, ecosystem: str, sha256: str) -> str:
        return f"raw/{source}/{ecosystem}/{sha256}.zip"

    def _exists(self, key: str) -> bool:
        try:
            self.s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def put(
        self,
        path: str,
        *,
        run_id: str,
        source: str,
        ecosystem: str,
        sha256: str,
        size: int,
        etag: str | None,
        source_url: str,
        fetched_at: str,
    ) -> str:
        """Store the file and return its key. Idempotent: identical content is stored once.

        Uploaded to a temporary key, size-checked, then copied into place, so a crash never leaves a
        partial object at the final key.
        """
        key = self.key(source, ecosystem, sha256)
        if not self._exists(key):
            tmp = f"tmp/{run_id}.zip"
            self.s3.upload_file(path, self.bucket, tmp, Config=_TRANSFER)
            try:
                if self.s3.head_object(Bucket=self.bucket, Key=tmp)["ContentLength"] != size:
                    raise RuntimeError("uploaded object size does not match the download")
                self.s3.copy_object(Bucket=self.bucket, Key=key, CopySource={"Bucket": self.bucket, "Key": tmp})
            finally:
                self.s3.delete_object(Bucket=self.bucket, Key=tmp)
        sidecar = f"raw/{source}/{ecosystem}/{sha256}.json"
        if not self._exists(sidecar):  # keep the first run's provenance
            meta = {
                "runId": run_id,
                "sourceUrl": source_url,
                "fetchedAt": fetched_at,
                "etag": etag,
                "sizeBytes": size,
            }
            self.s3.put_object(
                Bucket=self.bucket,
                Key=sidecar,
                Body=json.dumps(meta).encode(),
                ContentType="application/json",
            )
        return key
