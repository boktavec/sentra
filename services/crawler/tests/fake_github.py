"""A real local HTTP server standing in for `GET /advisories` on api.github.com.

It filters by `modified`, sorts by `updated_at` ascending, pages with `per_page` and an opaque `after`
cursor, and advertises the next page in a `Link` header, as the real API does (verified against the live
API on 2026-10-09). Scripted responses are served first, one per request, to inject rate limits and faults.
"""

import copy
import json
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

FIXTURES = Path(__file__).parent / "fixtures" / "ghsa"
START = datetime(2026, 10, 1, 8, 0, 0, tzinfo=UTC)


def stamp(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def make_advisories(n: int, start: datetime = START, step: timedelta = timedelta(minutes=10)) -> list[dict]:
    """n distinct advisories shaped like the real ones, `step` apart in `updated_at` (ascending)."""
    templates = json.loads((FIXTURES / "advisories.json").read_text())
    out = []
    for i in range(n):
        a = copy.deepcopy(templates[i % len(templates)])
        a["ghsa_id"] = f"GHSA-{i:04x}-aaaa-bbbb"
        a["updated_at"] = stamp(start + step * i)
        out.append(a)
    return out


@dataclass
class Reply:
    status: int = 200
    body: bytes = b"[]"
    headers: dict[str, str] = field(default_factory=dict)


class FakeGitHub:
    def __init__(self, advisories: list[dict] | None = None, *, remaining: int | None = 4999) -> None:
        self.advisories = advisories or []
        self.remaining = remaining  # sent as x-ratelimit-remaining on served pages; None omits the headers
        self.script: list[Reply] = []
        self.next_link_override: str | None = None  # replaces the Link target, to simulate a hostile server
        self.requests: list[tuple[str, dict[str, str]]] = []
        self.served: list[bytes] = []  # exact bodies of the pages that were served
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                outer.requests.append((self.path, dict(self.headers)))
                reply = outer.script.pop(0) if outer.script else outer._page(self.path)
                self.send_response(reply.status)
                for k, v in reply.headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(reply.body)))
                self.end_headers()
                self.wfile.write(reply.body)

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def _page(self, path: str) -> Reply:
        url = urlsplit(path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        assert url.path == "/advisories", url.path
        assert (q["type"], q["sort"], q["direction"]) == ("reviewed", "updated", "asc"), q
        size, offset = int(q["per_page"]), int(q["after"]) if "after" in q else 0
        items = self.advisories
        if "modified" in q:
            assert q["modified"].startswith(">="), q["modified"]
            items = [a for a in items if a["updated_at"] >= q["modified"][2:]]
        page = items[offset : offset + size]
        body = json.dumps(page, indent=2).encode()
        self.served.append(body)
        headers = {"Content-Type": "application/json; charset=utf-8"}
        if self.remaining is not None:
            headers["x-ratelimit-limit"] = "5000"
            headers["x-ratelimit-remaining"] = str(self.remaining)
        if offset + size < len(items):
            nxt = self.next_link_override or f"{self.base_url}/advisories?{urlencode({**q, 'after': offset + size})}"
            headers["Link"] = f'<{nxt}>; rel="next"'
        return Reply(body=body, headers=headers)

    def authorization_headers(self) -> set[str | None]:
        return {h.get("Authorization") for _, h in self.requests}

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
