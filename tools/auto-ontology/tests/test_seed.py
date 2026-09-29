# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler
from http.server import HTTPServer
from pathlib import Path
from typing import Any

import pytest
import seed

MODEL = "data_layer:\n  databases: []\n"


class FakeBackend(BaseHTTPRequestHandler):
    status = 200
    reply: dict[str, Any] = {"success": True, "summary": {"terms": 9}}
    received: list[dict[str, Any]] = []

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers["Content-Length"]))
        type(self).received.append({"path": self.path, "type": self.headers["Content-Type"], "body": body.decode()})
        payload = json.dumps(self.reply).encode()
        self.send_response(self.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: Any) -> None:
        pass


@pytest.fixture
def backend() -> Iterator[str]:
    FakeBackend.received = []
    server = HTTPServer(("127.0.0.1", 0), FakeBackend)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


@pytest.fixture
def model(tmp_path: Path) -> Path:
    path = tmp_path / "model.yaml"
    path.write_text(MODEL)
    return path


def test_posts_the_model_to_the_import_route(backend: str, model: Path) -> None:
    summary = seed.import_model(backend + "/", model, timeout=5)

    assert summary == {"terms": 9}
    assert FakeBackend.received == [
        {"path": "/api/model/import?replace=true&embed=true", "type": "application/x-yaml", "body": MODEL}
    ]


def test_a_rejected_model_fails_with_the_backend_detail(
    backend: str, model: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(FakeBackend, "status", 422)
    monkeypatch.setattr(FakeBackend, "reply", {"detail": "Unknown database ids"})
    monkeypatch.setenv("AUTO_ONTOLOGY_API_URL", backend)
    monkeypatch.setenv("AUTO_ONTOLOGY_MODEL", str(model))

    assert seed.main() == 1
    assert "HTTP 422" in capsys.readouterr().err


def test_an_import_without_success_fails(backend: str, model: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(FakeBackend, "reply", {"success": False})

    with pytest.raises(RuntimeError, match="did not report success"):
        seed.import_model(backend, model, timeout=5)


def test_a_missing_model_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTO_ONTOLOGY_MODEL", str(tmp_path / "missing.yaml"))

    assert seed.main() == 1
