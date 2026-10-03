# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""A stand-in for the Kumo NIM behind the proxy in proxy-test.sh: answers the client's two probes, and echoes
what reached it for any other request (method, path, body size and digest, whether an X-API-Key arrived).

Standard library only, so it runs in a plain Python image.
"""

import hashlib
import json
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer

PROBES = {
    "/v1/health/ready": {"status": "ready"},
    "/v1/models": {"object": "list", "data": [{"id": "kumo-relational", "object": "model"}]},
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def body(self) -> bytes:
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks = []
            while size := int(self.rfile.readline().split(b";")[0], 16):
                chunks.append(self.rfile.read(size))
                self.rfile.readline()
            self.rfile.readline()
            return b"".join(chunks)
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def answer(self) -> None:
        body = self.body()
        reply = PROBES.get(self.path, {}) | {
            "method": self.command,
            "path": self.path,
            "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
            "x_api_key": "X-API-Key" in self.headers,
        }
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_DELETE = answer


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
