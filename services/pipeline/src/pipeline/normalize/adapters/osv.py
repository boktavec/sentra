from typing import Any

# Bump when the mapping changes what a record normalizes to; rows written by an older adapter are
# rewritten on the next reprocess even if the advisory itself is unchanged.
ADAPTER_VERSION = 1

SOURCE = "osv"
RANGE_TYPES = {"SEMVER", "ECOSYSTEM"}  # GIT ranges name commits; an SBOM has package versions
EVENT_TYPES = {"introduced", "fixed", "last_affected"}


class NormalizeError(ValueError):
    """The record uses something this adapter does not map. It is quarantined, not guessed at."""


def _ranges(affected: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in affected.get("ranges") or []:
        if r.get("type") == "GIT":
            continue
        if r.get("type") not in RANGE_TYPES:
            raise NormalizeError(f"unsupported range type {r.get('type')!r}")
        events = []
        for e in r.get("events") or []:
            if not isinstance(e, dict) or len(e) != 1:
                raise NormalizeError(f"malformed range event {e!r}")
            ((kind, version),) = e.items()
            if kind not in EVENT_TYPES:
                raise NormalizeError(f"unsupported range event {kind!r}")
            events.append({"type": kind, "version": version})
        out.append({"type": r["type"], "events": events})
    return out


def normalize(raw: dict[str, Any]) -> dict[str, Any]:
    """Map one OSV advisory to the canonical vulnerability shape (not yet validated).

    An `affected` entry without a package (for example a git-only one) is dropped: there is nothing to
    match a dependency against.
    """
    if not isinstance(raw, dict):
        raise NormalizeError("record is not a JSON object")
    affected = []
    for a in raw.get("affected") or []:
        package = a.get("package")
        if not isinstance(package, dict) or not package.get("name") or not package.get("ecosystem"):
            continue
        affected.append(
            {
                "ecosystem": package["ecosystem"],
                "packageName": package["name"],
                "purl": package.get("purl"),
                "versions": list(a.get("versions") or []),
                "ranges": _ranges(a),
            }
        )
    return {
        "source": SOURCE,
        "sourceId": raw.get("id"),
        "aliases": list(raw.get("aliases") or []),
        "summary": raw.get("summary"),
        "details": raw.get("details"),
        "publishedAt": raw.get("published"),
        "modifiedAt": raw.get("modified"),
        "withdrawnAt": raw.get("withdrawn"),
        # OSV calls the CVSS vector string `score`.
        "severity": [{"type": s.get("type"), "vector": s.get("score")} for s in raw.get("severity") or []],
        "references": [{"type": r.get("type"), "url": r.get("url")} for r in raw.get("references") or []],
        "affected": affected,
    }
