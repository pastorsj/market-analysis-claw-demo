# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""``demo-api record`` writes the v2 recordings bundle the UI replays."""

from __future__ import annotations

import json

import httpx
from support import PACK

from demo_api.cli import record

PUBLIC_PACK = {"id": "market-analysis", "version": "1.0.0", "questions": PACK["questions"]}


SQL = "SELECT asset_id FROM assets"
SQL_RECEIPT = {"artifactKind": "structured_query", "content": {"databaseName": "market_analysis", "sql": SQL}}
SCHEMA = {
    "source_id": "market_analysis_structured",
    "database_name": "market_analysis",
    "tables": [{"name": "assets", "schema": "main", "kind": "table", "columns": []}],
    "relationships": [],
}
ROWS = {"columns": ["asset_id"], "types": ["VARCHAR"], "rows": [["A1"]], "truncated": False, "duration_ms": 3}


def fake_api(statuses: dict[str, str], requests: list[str] | None = None) -> httpx.MockTransport:
    """Answers every question at once; ``statuses`` maps a question to its final job status."""
    jobs: dict[str, dict] = {}
    seen = requests if requests is not None else []

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        seen.append(f"{request.method} {path}")
        if path == "/v1/pack":
            return httpx.Response(200, json=PUBLIC_PACK)
        if path == "/v1/data_sources":
            structured = {"id": "market_analysis_structured", "name": "Prices", "database_name": "market_analysis"}
            return httpx.Response(200, json=[structured, {"id": "market_news", "name": "Filings"}])
        if path.endswith("/schema"):
            return httpx.Response(200, json=SCHEMA)
        if path.endswith("/preview"):
            assert request.url.params["limit"] == "8"
            return httpx.Response(200, json={"table": request.url.params["table"], **ROWS})
        if path.endswith("/query"):
            return httpx.Response(200, json=ROWS)
        if path.endswith("/benchmark"):
            return httpx.Response(422, json={"detail": "no market calls"})
        if path == "/v1/jobs/async/submit":
            body = json.loads(request.content)
            jobs[body["job_id"]] = {"question": body["input"], "status": statuses[body["input"]]}
            return httpx.Response(200, json={"job_id": body["job_id"], "status": "submitted"})
        job_id = path.split("/")[5]
        job = jobs[job_id]
        if path.endswith("/export"):
            report = {"markdown": "Answer [1]", "citations": []}
            turn = {"jobId": job_id, "question": job["question"], "status": job["status"], "report": report}
            return httpx.Response(200, json=turn | {"events": [], "receipts": [SQL_RECEIPT]})
        return httpx.Response(200, json={"job_id": job_id, "status": job["status"], "error": None})

    return httpx.MockTransport(handle)


def test_record_writes_index_pack_snapshot_and_one_session_per_question(tmp_path, data_dir):
    statuses = {question["question"]: "success" for question in PACK["questions"]}
    requests: list[str] = []
    with httpx.Client(transport=fake_api(statuses, requests), base_url="http://api.test") as client:
        code = record(
            client, data_dir=data_dir, out_dir=tmp_path / "rec", question_ids=[], featured_only=False, timeout=5
        )

    assert code == 0
    index = json.loads((tmp_path / "rec" / "index.json").read_text())
    assert (index["schemaVersion"], index["pack"]) == (2, {"id": "market-analysis", "version": "1.0.0"})
    assert [(s["id"], s["title"], s["featured"]) for s in index["sessions"]] == [
        ("market-leaders", "Market Leaders", True),
        ("filings", "Filings", False),
    ]
    session = json.loads((tmp_path / "rec" / "sessions" / "market-leaders.json").read_text())
    assert (session["schemaVersion"], session["id"], session["title"]) == (2, "market-leaders", "Market Leaders")
    assert session["turns"][0]["jobId"] == index["sessions"][0]["turns"][0]["jobId"]
    assert json.loads((tmp_path / "rec" / "pack.json").read_text()) == PACK
    # Every answer was offered for a CPU/GPU comparison, and the data viewer's copy covers the recorded query
    assert sum(request.endswith("/benchmark") for request in requests) == 2
    database = json.loads((tmp_path / "rec" / "database.json").read_text())
    assert database == {
        "schemaVersion": 1,
        "sources": [
            {
                "id": "market_analysis_structured",
                "name": "Prices",
                "databaseName": "market_analysis",
                "schema": SCHEMA,
                "previews": {"assets": {"table": "assets", **ROWS}},
                "queries": [
                    {"sql": SQL, "result": ROWS},
                    {"sql": 'SELECT * FROM "main"."assets" LIMIT 25', "result": ROWS},
                ],
            }
        ],
    }


def test_a_question_that_fails_is_left_out_and_the_command_fails(tmp_path, data_dir):
    statuses = {PACK["questions"][0]["question"]: "failure"}
    with httpx.Client(transport=fake_api(statuses), base_url="http://api.test") as client:
        code = record(client, data_dir=data_dir, out_dir=tmp_path, question_ids=[], featured_only=True, timeout=5)

    assert code == 1
    assert json.loads((tmp_path / "index.json").read_text())["sessions"] == []
