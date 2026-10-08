import hashlib
import json
import tempfile
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from typing import IO, Any

from .config import Limits


class ArchiveError(Exception):
    """The artifact cannot be processed at all (tampered, oversize, a zip bomb). Fails the whole run."""


@dataclass(frozen=True)
class Entry:
    name: str
    record: Any  # decoded JSON, or None when `error` is set
    error: str | None = None


def download(s3: Any, bucket: str, key: str, sha256: str, max_bytes: int) -> IO[bytes]:
    """Copy the object to a temp file (a zip needs random access), checking its size and SHA-256.

    Never holds more than one chunk in memory. The caller closes the file.
    """
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"]
    digest, size = hashlib.sha256(), 0
    out = tempfile.TemporaryFile()  # noqa: SIM115 - returned to the caller, who closes it
    try:
        for chunk in body.iter_chunks(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                raise ArchiveError(f"artifact is larger than {max_bytes} bytes")
            digest.update(chunk)
            out.write(chunk)
    except BaseException:
        out.close()
        raise
    finally:
        body.close()
    if digest.hexdigest() != sha256:
        out.close()
        raise ArchiveError("artifact does not match its sha256")
    out.seek(0)
    return out


def entries(file: IO[bytes], limits: Limits) -> Iterator[Entry]:
    """Yield every .json entry, decoded, one at a time.

    Limits are checked on the declared sizes first, then on the bytes actually read, because a zip
    can declare small sizes and expand large. A tripped limit raises ArchiveError; an entry that is
    not valid JSON is yielded with `error` so it can be quarantined.
    """
    try:
        zf = zipfile.ZipFile(file)
        infos = [i for i in zf.infolist() if not i.is_dir() and i.filename.endswith(".json")]
    except zipfile.BadZipFile as e:
        raise ArchiveError(f"not a readable zip: {e}") from e
    if len(infos) > limits.max_entries:
        raise ArchiveError(f"{len(infos)} entries, limit {limits.max_entries}")
    if sum(i.file_size for i in infos) > limits.max_total_bytes:
        raise ArchiveError(f"declared size is over {limits.max_total_bytes} bytes")
    total = 0
    for info in infos:
        if info.file_size > limits.max_entry_bytes:
            raise ArchiveError(f"entry {info.filename} declares {info.file_size} bytes, limit {limits.max_entry_bytes}")
        try:
            with zf.open(info) as f:
                data = f.read(limits.max_entry_bytes + 1)
        except (zipfile.BadZipFile, OSError, EOFError) as e:
            raise ArchiveError(f"cannot read {info.filename}: {e}") from e
        if len(data) > limits.max_entry_bytes:
            raise ArchiveError(f"entry {info.filename} expands past {limits.max_entry_bytes} bytes")
        total += len(data)
        if total > limits.max_total_bytes:
            raise ArchiveError(f"archive expands past {limits.max_total_bytes} bytes")
        try:
            yield Entry(info.filename, json.loads(data))
        except (ValueError, RecursionError) as e:  # RecursionError: absurdly nested JSON
            yield Entry(info.filename, None, f"not valid JSON: {e}")
