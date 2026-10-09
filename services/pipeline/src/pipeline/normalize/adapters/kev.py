import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import IO, Any

from ..archive import ArchiveError

# Bump when the mapping changes what an entry normalizes to; rows from an older adapter are rewritten.
ADAPTER_VERSION = 1

SOURCE = "cisa-kev"
ECOSYSTEM = "none"  # one global catalog; the contracts require a non-empty ecosystem
CVE_ID = re.compile(r"^CVE-\d{4}-\d{4,}$")


@dataclass(frozen=True)
class Snapshot:
    catalog_version: str
    date_released: str
    entries: list[Any]


def parse(f: IO[bytes], max_bytes: int) -> Snapshot:
    """Read the catalog and check it is whole. Anything off fails the run before any row changes, because
    a truncated or empty catalog would otherwise look like mass removals."""
    data = f.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ArchiveError(f"catalog is larger than {max_bytes} bytes")
    try:
        doc = json.loads(data)
    except (ValueError, RecursionError) as e:
        raise ArchiveError(f"not valid JSON: {e}") from e
    if not isinstance(doc, dict) or not isinstance(doc.get("vulnerabilities"), list):
        raise ArchiveError("catalog has no vulnerabilities list")
    entries = doc["vulnerabilities"]
    if not entries:
        raise ArchiveError("catalog is empty")
    if doc.get("count") != len(entries):
        raise ArchiveError(f"catalog declares {doc.get('count')!r} entries but has {len(entries)}")
    version, released = doc.get("catalogVersion"), doc.get("dateReleased")
    if not isinstance(version, str) or not version or not isinstance(released, str):
        raise ArchiveError("catalog has no catalogVersion or dateReleased")
    try:
        datetime.fromisoformat(released)
    except ValueError as e:
        raise ArchiveError(f"bad dateReleased: {e}") from e
    return Snapshot(version, released, entries)


def cve_id(raw: Any) -> str | None:
    value = raw.get("cveID") if isinstance(raw, dict) else None
    return value if isinstance(value, str) and CVE_ID.match(value) else None


def _text(raw: dict[str, Any], key: str) -> str | None:
    value = raw.get(key)
    return value.strip() or None if isinstance(value, str) else None  # the feed pads some names


def entry(raw: Any) -> dict[str, Any]:
    """One catalog entry as a kev_entries row. Raises ValueError for an entry that cannot be mapped."""
    cve = cve_id(raw)
    if cve is None:
        raise ValueError("missing or malformed cveID")
    added = date.fromisoformat(raw.get("dateAdded") or "")
    due = raw.get("dueDate")
    cwes = raw.get("cwes") or []
    if not isinstance(cwes, list) or not all(isinstance(c, str) for c in cwes):
        raise ValueError("cwes is not a list of strings")
    return {
        "cve_id": cve,
        "vendor_project": _text(raw, "vendorProject"),
        "product": _text(raw, "product"),
        "name": _text(raw, "vulnerabilityName"),
        "description": _text(raw, "shortDescription"),
        "required_action": _text(raw, "requiredAction"),
        "date_added": added,
        "due_date": date.fromisoformat(due) if due else None,
        "known_ransomware_use": _text(raw, "knownRansomwareCampaignUse"),
        "cwes": cwes,
        "notes": _text(raw, "notes"),
        "content_hash": hashlib.sha256(json.dumps(raw, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
    }


def normalize(raw: Any) -> dict[str, Any]:
    """The canonical vulnerability row for a KEV entry. It carries no affected packages: KEV names a vendor
    and product, not an ecosystem package, and an affected row would only add noise to matching.

    `modifiedAt` is dateAdded because the catalog has no modified time; the entry's own content hash
    (see `entry`) is what decides whether kev_entries is rewritten."""
    cve = cve_id(raw)
    if cve is None:
        raise ValueError("missing or malformed cveID")
    added = f"{date.fromisoformat(raw.get('dateAdded') or '').isoformat()}T00:00:00Z"
    return {
        "source": SOURCE,
        "sourceId": cve,
        "aliases": [],
        "summary": _text(raw, "vulnerabilityName"),
        "details": _text(raw, "shortDescription"),
        "publishedAt": added,
        "modifiedAt": added,
        "withdrawnAt": None,
        "severity": [],
        "references": [],
        "affected": [],
    }
