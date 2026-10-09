"""A real local HTTP server for tests: scripted responses, every request recorded."""

import json
from collections.abc import Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread


@dataclass
class Seen:
    path: str
    headers: dict[str, str]
    body: dict


Responder = Callable[[Seen], tuple[int, object]]


class StubServer:
    def __init__(self, respond: Responder):
        self.requests: list[Seen] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers["Content-Length"])
                seen = Seen(
                    self.path, {k.lower(): v for k, v in self.headers.items()}, json.loads(self.rfile.read(length))
                )
                outer.requests.append(seen)
                status, body = respond(seen)
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format: str, *args: object) -> None:
                pass

        self._http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = Thread(target=self._http.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._http.server_port}"

    def close(self) -> None:
        self._http.shutdown()
        self._thread.join()
        self._http.server_close()
