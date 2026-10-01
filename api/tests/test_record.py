# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""``demo-api record`` writes the v2 recordings bundle the UI replays."""

from __future__ import annotations

import json

import httpx
import pytest
from support import PACK

from demo_api.cli import public_model_ids
from demo_api.cli import record

PUBLIC_PACK = {
    "id": "market-analysis",
    "version": "1.0.0",
    "questions": PACK["questions"],
    "conversations": PACK["conversations"],
}
ALL_QUESTIONS = [question["question"] for question in PACK["questions"]] + PACK["conversations"][0]["turns"]


SQL = "SELECT asset_id FROM assets"
SQL_RECEIPT = {"artifactKind": "structured_query", "content": {"databaseName": "market_analysis", "sql": SQL}}
SCHEMA = {
    "source_id": "market_analysis_structured",
    "database_name": "market_analysis",
    "tables": [{"name": "assets", "schema": "main", "kind": "table", "columns": []}],
    "relationships": [],
}
# A model call served through a gateway that prefixes model ids with their provider
GATEWAY_LLM_CALL = {
    "eventKind": "llm.call",
    "display": {"attributes": {"served_model": "openai/openai/gpt-6.1-sol", "tier": "capable"}},
}
ROWS = {"columns": ["asset_id"], "types": ["VARCHAR"], "rows": [["A1"]], "truncated": False, "duration_ms": 3}


def fake_api(
    statuses: dict[str, str], requests: list[str] | None = None, conversations: list[str] | None = None
) -> httpx.MockTransport:
    """Answers every question at once; ``statuses`` maps a question to its final job status (default success).

    ``conversations`` collects the conversation-id of each submitted question.
    """
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
            jobs[body["job_id"]] = {"question": body["input"], "status": statuses.get(body["input"], "success")}
            if conversations is not None:
                conversations.append(request.headers["conversation-id"])
            return httpx.Response(200, json={"job_id": body["job_id"], "status": "submitted"})
        job_id = path.split("/")[5]
        job = jobs[job_id]
        if path.endswith("/export"):
            report = {"markdown": "Answer [1]", "citations": []}
            turn = {"jobId": job_id, "question": job["question"], "status": job["status"], "report": report}
            return httpx.Response(200, json=turn | {"events": [GATEWAY_LLM_CALL], "receipts": [SQL_RECEIPT]})
        return httpx.Response(200, json={"job_id": job_id, "status": job["status"], "error": None})

    return httpx.MockTransport(handle)


def test_record_writes_index_pack_snapshot_and_one_session_per_question_and_conversation(tmp_path, data_dir):
    requests: list[str] = []
    conversations: list[str] = []
    stale = tmp_path / "rec" / "sessions" / "retired.json"
    stale.parent.mkdir(parents=True)
    stale.write_text("{}")
    with httpx.Client(transport=fake_api({}, requests, conversations), base_url="http://api.test") as client:
        code = record(
            client, data_dir=data_dir, out_dir=tmp_path / "rec", question_ids=[], featured_only=False, timeout=5
        )

    assert code == 0
    index = json.loads((tmp_path / "rec" / "index.json").read_text())
    assert (index["schemaVersion"], index["pack"]) == (2, {"id": "market-analysis", "version": "1.0.0"})
    assert all(session["tools"] == [] for session in index["sessions"])  # the fake runs called no tool
    assert [(s["id"], s["title"], s["featured"], len(s["turns"])) for s in index["sessions"]] == [
        ("market-leaders", "Market Leaders", True, 1),
        ("filings", "Filings", False, 1),
        ("leaders-follow-up", "Leaders Follow-up", False, 2),
    ]
    session = json.loads((tmp_path / "rec" / "sessions" / "market-leaders.json").read_text())
    assert (session["schemaVersion"], session["id"], session["title"]) == (2, "market-leaders", "Market Leaders")
    assert session["turns"][0]["jobId"] == index["sessions"][0]["turns"][0]["jobId"]
    # A conversation's turns are asked in order in one conversation; each question has its own
    follow_up = json.loads((tmp_path / "rec" / "sessions" / "leaders-follow-up.json").read_text())
    assert [turn["question"] for turn in follow_up["turns"]] == PACK["conversations"][0]["turns"]
    assert [turn["question"] for turn in index["sessions"][2]["turns"]] == PACK["conversations"][0]["turns"]
    assert len(set(conversations)) == 3
    assert conversations[2] == conversations[3]
    assert not stale.exists()
    assert json.loads((tmp_path / "rec" / "pack.json").read_text()) == PACK
    # Every answer was offered for a CPU/GPU comparison, and the data viewer's copy covers the recorded query
    assert sum(request.endswith("/benchmark") for request in requests) == len(ALL_QUESTIONS)
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


def test_a_conversation_stops_at_a_failed_turn_and_is_left_out(tmp_path, data_dir):
    first, second = PACK["conversations"][0]["turns"]
    requests: list[str] = []
    with httpx.Client(transport=fake_api({first: "failure"}, requests), base_url="http://api.test") as client:
        code = record(client, data_dir=data_dir, out_dir=tmp_path, question_ids=[], featured_only=False, timeout=5)

    assert code == 1
    assert [session["id"] for session in json.loads((tmp_path / "index.json").read_text())["sessions"]] == [
        "market-leaders",
        "filings",
    ]
    assert requests.count("POST /v1/jobs/async/submit") == 3  # the second turn is never asked
    assert not (tmp_path / "sessions" / "leaders-follow-up.json").exists()


def test_recording_named_sessions_keeps_the_rest_of_the_bundle(tmp_path, data_dir):
    with httpx.Client(transport=fake_api({}), base_url="http://api.test") as client:
        record(client, data_dir=data_dir, out_dir=tmp_path, question_ids=[], featured_only=False, timeout=5)
        before = json.loads((tmp_path / "index.json").read_text())["sessions"]
        code = record(
            client,
            data_dir=data_dir,
            out_dir=tmp_path,
            question_ids=["leaders-follow-up", "market-leaders"],
            featured_only=True,
            timeout=5,
        )

    assert code == 0
    after = json.loads((tmp_path / "index.json").read_text())["sessions"]
    assert [session["id"] for session in after] == ["market-leaders", "filings", "leaders-follow-up"]
    assert after[1] == before[1]
    assert after[0]["turns"] != before[0]["turns"] and after[2]["turns"] != before[2]["turns"]
    assert sorted(path.stem for path in (tmp_path / "sessions").glob("*.json")) == [
        "filings",
        "leaders-follow-up",
        "market-leaders",
    ]


def test_served_model_ids_are_recorded_under_their_public_names(tmp_path, data_dir):
    with httpx.Client(transport=fake_api({}), base_url="http://api.test") as client:
        record(
            client, data_dir=data_dir, out_dir=tmp_path, question_ids=["market-leaders"], featured_only=True, timeout=5
        )

    turn = json.loads((tmp_path / "sessions" / "market-leaders.json").read_text())["turns"][0]
    assert turn["events"][0]["display"]["attributes"] == {"served_model": "gpt-6.1-sol", "tier": "capable"}


@pytest.mark.parametrize(
    ("served", "public"),
    [
        ("openai/openai/gpt-6.1-sol", "gpt-6.1-sol"),
        ("azure/openai/gpt-6.1-sol", "gpt-6.1-sol"),
        ("nvidia/nvidia/nemotron-3-ultra", "nemotron-3-ultra"),
        ("nvidia/nvidia/nemotron-3-super-v3", "nemotron-3-super-v3"),
        ("nvidia/nvidia/nemotron-3.5-lightning", "nemotron-3.5-lightning"),
        ("Escalated to openai/openai/gpt-6.1-sol.", "Escalated to gpt-6.1-sol."),
        # Public ids and other paths stay as they are
        ("nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3-ultra-550b-a55b"),
        ("nvidia/llama-nemotron-rerank-vl-1b-v2", "nvidia/llama-nemotron-rerank-vl-1b-v2"),
        ("/v1/jobs/async/job/x/export", "/v1/jobs/async/job/x/export"),
    ],
)
def test_public_model_ids(served, public):
    assert public_model_ids({"a": [served], "b": 3}) == {"a": [public], "b": 3}
