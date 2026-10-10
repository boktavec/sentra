import re
from collections.abc import Iterable, Iterator
from typing import Any

from ..archive import Entry

# Bump when the mapping changes what a record normalizes to; rows written by an older adapter are
# rewritten on the next reprocess even if the advisory itself is unchanged.
ADAPTER_VERSION = 1

SOURCE = "ghsa"

# GitHub's ecosystem names -> the OSV names the rest of the pipeline (SBOM parsing, matching) uses.
# An ecosystem not listed is kept as GitHub names it; nothing matches it until someone maps it.
ECOSYSTEMS = {
    "npm": "npm",
    "pip": "PyPI",
    "maven": "Maven",
    "go": "Go",
    "rust": "crates.io",
    "nuget": "NuGet",
    "rubygems": "RubyGems",
    "composer": "Packagist",
    "erlang": "Hex",
    "pub": "Pub",
    "actions": "GitHub Actions",
    "swift": "SwiftURL",
}
# GitHub writes ranges like ">= 1.0.0, < 1.4.2": at most one lower and one upper bound, or a single "= 1.2.3".
_CONSTRAINT = re.compile(r"(<=|>=|<|>|=)\s*(\S+)")


class NormalizeError(ValueError):
    """The record uses something this adapter does not map. It is quarantined, not guessed at."""


def expand(entries: Iterable[Entry]) -> Iterator[Entry]:
    """The crawler stores one zip entry per API page (a JSON array); yield one entry per advisory, named
    `<page>[<index>]`, so provenance points at the advisory. A page that is not an array is one bad entry."""
    for page in entries:
        if page.error or not isinstance(page.record, list):
            yield Entry(page.name, None, page.error or "page is not a JSON array")
            continue
        for i, advisory in enumerate(page.record):
            yield Entry(f"{page.name}[{i}]", advisory)


def _range(expression: str) -> tuple[list[str], list[dict[str, Any]]]:
    """A GitHub range expression -> (explicit versions, OSV-style ranges). Ranges are ecosystem-ordered."""
    parts = []
    for text in expression.split(","):
        m = _CONSTRAINT.fullmatch(text.strip())
        if m is None:
            raise NormalizeError(f"unsupported version range {expression!r}")
        parts.append(m.groups())
    if len(parts) == 1 and parts[0][0] == "=":
        return [parts[0][1]], []
    lower = [p for p in parts if p[0] in (">", ">=")]
    upper = [p for p in parts if p[0] in ("<", "<=")]
    if len(lower) + len(upper) != len(parts) or len(lower) > 1 or len(upper) > 1:
        raise NormalizeError(f"unsupported version range {expression!r}")
    if lower and lower[0][0] == ">":  # `introduced` is inclusive; widening the range would invent matches
        raise NormalizeError(f"exclusive lower bound is not supported: {expression!r}")
    events = [{"type": "introduced", "version": lower[0][1] if lower else "0"}]
    if upper:
        op, version = upper[0]
        events.append({"type": "fixed" if op == "<" else "last_affected", "version": version})
    return [], [{"type": "ECOSYSTEM", "events": events}]


def _affected(raw: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for v in raw.get("vulnerabilities") or []:
        package = v.get("package")
        if not isinstance(package, dict) or not package.get("name") or not package.get("ecosystem"):
            continue
        versions, ranges = _range(v["vulnerable_version_range"]) if v.get("vulnerable_version_range") else ([], [])
        out.append(
            {
                "ecosystem": ECOSYSTEMS.get(package["ecosystem"], package["ecosystem"]),
                "packageName": package["name"],
                "purl": None,
                "versions": versions,
                "ranges": ranges,
            }
        )
    return out


def _severity(raw: dict[str, Any]) -> list[dict[str, str]]:
    """CVSS vectors from `cvss_severities` (v3, v4) and the older top-level `cvss`, each once. The vector's
    own prefix says which version it is. GitHub's textual `severity` is not kept: it is derived from these."""
    severities = raw.get("cvss_severities") or {}
    found = [(severities.get(k) or {}).get("vector_string") for k in ("cvss_v3", "cvss_v4")]
    found.append((raw.get("cvss") or {}).get("vector_string"))
    out: list[dict[str, str]] = []
    for vector in dict.fromkeys(v for v in found if v):
        kind = "CVSS_V4" if vector.startswith("CVSS:4") else "CVSS_V3" if vector.startswith("CVSS:3") else "CVSS_V2"
        out.append({"type": kind, "vector": vector})
    return out


def _references(raw: dict[str, Any]) -> list[dict[str, str]]:
    urls = [("ADVISORY", raw.get("html_url")), *(("WEB", u) for u in raw.get("references") or [])]
    seen: dict[str, str] = {}
    for kind, url in urls:
        if url:
            seen.setdefault(url, kind)
    return [{"type": kind, "url": url} for url, kind in seen.items()]


def normalize(raw: dict[str, Any]) -> dict[str, Any]:
    """Map one GitHub global advisory to the canonical vulnerability shape (not yet validated).

    Withdrawn advisories are kept with `withdrawnAt` set, so a later withdrawal updates the stored row
    instead of leaving a stale active one; the correlator already ignores withdrawn rows.
    """
    if not isinstance(raw, dict):
        raise NormalizeError("record is not a JSON object")
    ghsa_id = raw.get("ghsa_id")
    identifiers = [i.get("value") for i in raw.get("identifiers") or [] if isinstance(i, dict)]
    aliases = [a for a in dict.fromkeys([raw.get("cve_id"), *identifiers]) if a and a != ghsa_id]
    return {
        "source": SOURCE,
        "sourceId": ghsa_id,
        "aliases": aliases,
        "summary": raw.get("summary"),
        "details": raw.get("description"),
        "publishedAt": raw.get("published_at"),
        "modifiedAt": raw.get("updated_at"),
        "withdrawnAt": raw.get("withdrawn_at"),
        "severity": _severity(raw),
        "references": _references(raw),
        "affected": _affected(raw),
    }
