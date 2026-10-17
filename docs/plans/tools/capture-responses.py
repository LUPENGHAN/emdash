"""A fake model provider that records requests and answers every one with HTTP 400.

Point an agent's provider base URL at it to see exactly what the agent would send,
without reaching a real provider or spending any quota.

    python3 -I docs/plans/tools/capture-responses.py /tmp/captured.jsonl [port]

Each request becomes one JSON line: {"path", "headers", "body"}; the Authorization
header is never written. Stop it with Ctrl+C or `kill`.
"""

import http.server
import json
import sys

OUT = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 4999


class Handler(http.server.BaseHTTPRequestHandler):
    def _record(self, body: str) -> None:
        headers = {k: v for k, v in self.headers.items() if k.lower() != "authorization"}
        with open(OUT, "a", encoding="utf8") as f:
            f.write(json.dumps({"method": self.command, "path": self.path, "headers": headers, "body": body}) + "\n")

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", 0))
        self._record(self.rfile.read(length).decode("utf8", "replace"))
        self.send_response(400)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":{"message":"captured","type":"invalid_request"}}')

    def do_GET(self) -> None:
        self._record("")
        self.send_response(404)
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - base signature
        del format, args


http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
