import hashlib
import io
import json
import zipfile

import pytest

from pipeline.normalize import archive
from pipeline.normalize.archive import ArchiveError
from pipeline.normalize.config import Limits


def make_zip(files: dict[str, bytes], compression=zipfile.ZIP_DEFLATED) -> io.BytesIO:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    buf.seek(0)
    return buf


def test_yields_json_entries_and_flags_invalid_json():
    z = make_zip({"a.json": b'{"id": "A"}', "b.json": b"{nope", "readme.txt": b"skip me"})
    got = list(archive.entries(z, Limits()))
    assert [(e.name, e.record, e.error is None) for e in got] == [
        ("a.json", {"id": "A"}, True),
        ("b.json", None, False),
    ]


def test_not_a_zip_is_an_archive_error():
    with pytest.raises(ArchiveError, match="not a readable zip"):
        list(archive.entries(io.BytesIO(b"PK nope"), Limits()))


def test_too_many_entries():
    z = make_zip({f"{i}.json": b"{}" for i in range(3)})
    with pytest.raises(ArchiveError, match="entries"):
        list(archive.entries(z, Limits(max_entries=2)))


def test_declared_entry_size_over_limit():
    z = make_zip({"a.json": json.dumps({"x": "y" * 500}).encode()})
    with pytest.raises(ArchiveError, match="declares"):
        list(archive.entries(z, Limits(max_entry_bytes=100)))


def test_declared_total_over_limit():
    z = make_zip({f"{i}.json": b'{"k": "' + b"v" * 100 + b'"}' for i in range(5)})
    with pytest.raises(ArchiveError, match="declared size"):
        list(archive.entries(z, Limits(max_total_bytes=300)))


def test_a_zip_bomb_is_stopped_by_the_limits():
    # 5 MiB of one repeated byte compresses to a few KiB.
    z = make_zip({"bomb.json": b'["' + b"a" * (5 * 1024**2) + b'"]'})
    assert len(z.getvalue()) < 20_000
    with pytest.raises(ArchiveError):
        list(archive.entries(z, Limits(max_entry_bytes=1024**2)))


def test_a_declared_size_that_lies_fails_the_run(monkeypatch):
    z = make_zip({"a.json": b'["' + b"a" * 5000 + b'"]'})
    real = zipfile.ZipFile.infolist

    def lying(self):
        infos = real(self)
        for i in infos:
            i.file_size = 10
        return infos

    monkeypatch.setattr(zipfile.ZipFile, "infolist", lying)
    # zipfile reads only the declared 10 bytes, so the CRC fails; either way the run fails, nothing is trusted.
    with pytest.raises(ArchiveError):
        list(archive.entries(z, Limits(max_entry_bytes=1000)))


class FakeBody:
    def __init__(self, data: bytes):
        self.data = data

    def iter_chunks(self, size: int):
        for i in range(0, len(self.data), size):
            yield self.data[i : i + size]

    def close(self):
        pass


class FakeS3:
    def __init__(self, data: bytes):
        self.data = data

    def get_object(self, Bucket, Key):  # noqa: N803
        return {"Body": FakeBody(self.data)}


def test_download_checks_the_sha256():
    data = make_zip({"a.json": b"{}"}).getvalue()
    sha = hashlib.sha256(data).hexdigest()
    with archive.download(FakeS3(data), "b", "k", sha, 1 << 20) as f:
        assert f.read() == data
    with pytest.raises(ArchiveError, match="sha256"):
        archive.download(FakeS3(data), "b", "k", "0" * 64, 1 << 20)


def test_download_enforces_the_size_cap():
    data = b"x" * 2000
    with pytest.raises(ArchiveError, match="larger"):
        archive.download(FakeS3(data), "b", "k", hashlib.sha256(data).hexdigest(), 1000)
