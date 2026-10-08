import json
from pathlib import Path

import pytest

from pipeline.validate import SUPPORTED_SPEC_VERSIONS, check

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "cyclonedx-1.6.json"


def bom(**over: object) -> bytes:
    return json.dumps({"bomFormat": "CycloneDX", "specVersion": "1.6", "version": 1, **over}).encode()


def test_real_cyclonedx_fixture_is_accepted():
    assert check(FIXTURE.read_bytes()) is None


@pytest.mark.parametrize("version", sorted(SUPPORTED_SPEC_VERSIONS))
def test_every_supported_spec_version_is_accepted(version: str):
    assert check(bom(specVersion=version)) is None


@pytest.mark.parametrize(
    ("data", "reason"),
    [
        (b"", "not_json"),
        (b"   ", "not_json"),
        (b"<bom xmlns='http://cyclonedx.org/schema/bom/1.6'/>", "not_json"),
        (b"\xff\xfe\x00 not utf-8", "not_json"),
        (b'{"bomFormat": "CycloneDX"', "not_json"),
        (b"[" * 100_000, "not_json"),
        (b"[]", "not_cyclonedx"),
        (b'"CycloneDX"', "not_cyclonedx"),
        (b"{}", "not_cyclonedx"),
        (bom(bomFormat="SPDX"), "not_cyclonedx"),
        (bom(bomFormat="cyclonedx"), "not_cyclonedx"),
        (json.dumps({"spdxVersion": "SPDX-2.3"}).encode(), "not_cyclonedx"),
        (bom(specVersion="1.3"), "unsupported_version"),
        (bom(specVersion="2.0"), "unsupported_version"),
        (bom(specVersion=1.6), "unsupported_version"),
        (bom(specVersion=None), "unsupported_version"),
        (json.dumps({"bomFormat": "CycloneDX"}).encode(), "unsupported_version"),
    ],
)
def test_rejects_with_a_reason(data: bytes, reason: str):
    assert check(data) == reason
