"""Small, explicit REST client for the YouTrack MCP tools."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen


class YouTrackError(RuntimeError):
    """A YouTrack request failed without exposing credentials."""


def _env_file_values(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    values: dict[str, str] = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def segment(value: str) -> str:
    """Encode an identifier as one URL path segment."""
    if not value or not value.strip():
        raise ValueError("An identifier is required")
    return quote(value.strip(), safe="")


class YouTrackClient:
    def __init__(self, base_url: str, token: str) -> None:
        parsed = urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("YOUTRACK_URL must be an HTTP(S) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError(
                "YOUTRACK_URL must not contain credentials, query, or fragment"
            )
        if parsed.scheme == "http" and parsed.hostname not in {
            "localhost",
            "127.0.0.1",
            "::1",
        }:
            raise ValueError("Use HTTPS for a non-local YouTrack URL")
        if not token:
            raise ValueError("YOUTRACK_TOKEN is required")
        self.base_url = base_url.rstrip("/")
        self.token = token

    @classmethod
    def from_environment(cls) -> YouTrackClient:
        values = _env_file_values(os.environ.get("YOUTRACK_ENV_FILE"))
        base_url = os.environ.get("YOUTRACK_URL") or values.get("YOUTRACK_URL", "")
        token = os.environ.get("YOUTRACK_TOKEN") or values.get("YOUTRACK_TOKEN", "")
        return cls(base_url, token)

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        if not path.startswith("/api/"):
            raise ValueError("Only YouTrack API paths are allowed")
        url = self.base_url + path
        if params:
            url += "?" + urlencode(params)
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = Request(url, data=payload, headers=headers, method=method)
        try:
            with urlopen(request, timeout=20) as response:
                data = response.read()
        except HTTPError as error:
            detail = error.read(1000).decode("utf-8", errors="replace")
            detail = detail.replace(self.token, "[redacted]")
            raise YouTrackError(
                f"YouTrack returned HTTP {error.code}: {detail}"
            ) from None
        except URLError as error:
            raise YouTrackError(f"Cannot reach YouTrack: {error.reason}") from None
        if not data:
            return None
        try:
            return json.loads(data)
        except json.JSONDecodeError:
            raise YouTrackError("YouTrack returned an invalid JSON response") from None
