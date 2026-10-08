"""A real local HTTP server standing in for the OSV bucket, with scripted responses per path."""

import io
import threading
import time
import zipfile
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def make_zip(*names: str) -> bytes:
    """A zip of real OSV advisories (fixtures/), shaped like the bucket's all.zip."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in names or [p.name for p in sorted(FIXTURES.glob("*.json"))]:
            z.writestr(name, (FIXTURES / name).read_bytes() if (FIXTURES / name).exists() else b"{}")
    return buf.getvalue()


@dataclass
class Response:
    status: int = 200
    body: bytes = b""
    etag: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    delay: float = 0.0
    truncate: bool = False  # promise more bytes than we send, then hang up
    omit_length: bool = False  # no Content-Length: the body ends when the connection closes


class FakeOSV:
    def __init__(self) -> None:
        self.script: dict[str, list[Response]] = {}
        self.requests: list[tuple[str, dict[str, str]]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                outer.requests.append((self.path, dict(self.headers)))
                queue = outer.script.get(self.path)
                if not queue:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                r = queue.pop(0) if len(queue) > 1 else queue[0]  # the last response repeats
                time.sleep(r.delay)
                self.send_response(r.status)
                if r.etag:
                    self.send_header("ETag", r.etag)
                for k, v in r.headers.items():
                    self.send_header(k, v)
                if not r.omit_length:
                    self.send_header("Content-Length", str(len(r.body) + (1000 if r.truncate else 0)))
                self.end_headers()
                try:
                    self.wfile.write(r.body)
                except OSError:
                    pass
                if r.truncate:
                    self.close_connection = True

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def serve(self, path: str, *responses: Response) -> None:
        self.script[path] = list(responses)

    def count(self, path: str) -> int:
        return sum(1 for p, _ in self.requests if p == path)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
