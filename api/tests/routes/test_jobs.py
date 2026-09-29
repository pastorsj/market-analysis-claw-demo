# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""The job routes, end to end, against a fake Hermes: submit, run, receipts, answer, cancel, export."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from support import event
from support import receipt_for

from demo_api.hermes.request import correlation_ref
from demo_api.jobs.runner import API_RESTARTED
from demo_api.jobs.store import JobStatus
from demo_api.jobs.store import JobStore

RETRIEVE = "mcp__retrieval__retrieve_evidence"


async def submit(api: httpx.AsyncClient, job_id: str, **body: Any) -> httpx.Response:
    payload = {"agent_type": "hermes", "input": "Which filings mention outages?", "job_id": job_id} | body
    return await api.post("/v1/jobs/async/submit", json=payload, headers={"conversation-id": "conv-1"})


async def wait_for(api: httpx.AsyncClient, job_id: str, *statuses: str) -> dict[str, Any]:
    async with asyncio.timeout(5):
        while (job := (await api.get(f"/v1/jobs/async/job/{job_id}")).json())["status"] not in statuses:
            await asyncio.sleep(0.01)
    return job


async def wait_until_bound(app, job_id: str) -> None:
    async with asyncio.timeout(5):
        while (await app.state.services.store.get(job_id)).hermes_run_id is None:
            await asyncio.sleep(0.01)


def sse_frames(body: str) -> list[dict[str, Any]]:
    frames = []
    for block in body.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.split("\n") if not line.startswith(":"))
        frames.append({"id": fields.get("id"), "event": fields["event"], "data": json.loads(fields["data"])})
    return frames


def tool_events(call_id: str = "call_1") -> list[dict[str, Any]]:
    return [
        event("tool.started", tool=RETRIEVE, tool_call_id=call_id, preview="query"),
        event("message.delta", delta="thinking out loud"),
        event("tool.completed", tool=RETRIEVE, tool_call_id=call_id, duration=1.5, error=False),
    ]


async def test_a_question_runs_on_hermes_and_publishes_a_cited_answer(app, api, fake_hermes, post_receipt):
    response = await submit(api, "job-1", data_sources=["market_news", "market_analysis_structured"])
    assert response.json() == {"job_id": "job-1", "status": "submitted"}

    run_id = await fake_hermes.wait_for_run()
    start = fake_hermes.requests[0]
    payload = json.loads(start.content)
    assert start.headers["Idempotency-Key"] == "job-1"
    assert start.headers["Authorization"] == "Bearer test-hermes-key"
    assert payload["model"] == "enterprise-research"
    assert payload["session_id"] == "job-1"
    assert payload["enabled_toolsets"] == ["skills", "market_analytics", "retrieval"]
    assert payload["metadata"]["aiq.job.ref"] == correlation_ref("job-1")
    assert "market_news, market_analysis_structured" in payload["instructions"]

    await wait_until_bound(app, "job-1")
    receipt = receipt_for("job-1")
    assert (await post_receipt(receipt)).json() == {"receipt_id": receipt["receiptId"], "duplicate": False}
    assert (await post_receipt(receipt)).json()["duplicate"] is True  # stored once
    answer = f"Two filings report outages [evidence:{receipt['receiptId']}]. One is invented [evidence:bogus-1]."
    usage = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
    fake_hermes.finish(run_id, events=[*tool_events(), event("run.completed", usage=usage)], output=answer)

    job = await wait_for(api, "job-1", "success")
    assert job["error"] is None
    report = (await api.get("/v1/jobs/async/job/job-1/report")).json()
    assert report["has_report"] is True
    assert report["report"].startswith("Two filings report outages [1]. One is invented.")
    assert (
        f"- [1] Unstructured Retrieval evidence — 3 documents — evidence `{receipt['receiptId']}`" in report["report"]
    )
    assert "## Evidence limitation" in report["report"]

    frames = sse_frames((await api.get("/v1/jobs/async/job/job-1/stream")).text)
    kinds = [f["data"].get("eventKind", f["event"]) for f in frames]
    assert kinds[:2] == ["stream.start", "stream.mode"]
    assert kinds[2:] == [
        "run.created",
        "artifact.available",
        "tool.started",
        "tool.completed",
        "run.completed",
        "artifact.update",
        "stream.mode",
        "job.status",
    ]
    assert all((f["id"] is None) == (f["event"] in {"stream.start", "stream.mode", "job.status"}) for f in frames)
    assert frames[-1]["data"] == {"status": "success"}
    receipt_event = frames[3]["data"]
    assert receipt_event["artifactRefs"] == [receipt["receiptId"]]
    assert (receipt_event["toolName"], receipt_event["componentId"]) == ("retrieve_evidence", "milvus.retrieval")
    assert receipt_event["runId"] == run_id
    assert frames[4]["data"]["invocationId"] == receipt["invocationId"]  # tool events join their receipt

    turn = (await api.get("/v1/jobs/async/job/job-1/export")).json()
    assert set(turn) == {
        "jobId",
        "question",
        "submittedAt",
        "completedAt",
        "status",
        "report",
        "events",
        "receipts",
        "sourceIds",
    }
    assert turn["sourceIds"] == ["market_news", "market_analysis_structured"]
    assert turn["status"] == "success"
    assert turn["report"]["citations"][0]["evidenceId"] == receipt["receiptId"]
    assert [e["cursor"] for e in turn["events"]] == sorted(e["cursor"] for e in turn["events"])
    assert {e["schemaVersion"] for e in turn["events"]} == {"2"}
    assert [r["receiptId"] for r in turn["receipts"]] == [receipt["receiptId"]]


async def test_an_answer_whose_tool_evidence_never_arrived_fails(app, api, fake_hermes):
    await submit(api, "job-1")
    run_id = await fake_hermes.wait_for_run()
    fake_hermes.finish(run_id, events=[*tool_events(), event("run.completed")], output="An answer.")

    job = await wait_for(api, "job-1", "failure")
    assert job["error"] == "Hermes finished, but the evidence for its tool calls was not recorded; please retry."


async def test_a_failed_hermes_run_fails_the_job_with_a_public_message(api, fake_hermes):
    await submit(api, "job-1")
    run_id = await fake_hermes.wait_for_run()
    fake_hermes.finish(run_id, events=[event("run.failed", error="api_key=abc123 upstream 500")], status="failed")

    job = await wait_for(api, "job-1", "failure")
    assert job["error"] == "Hermes could not complete this request; please retry or check service health."
    frames = sse_frames((await api.get("/v1/jobs/async/job/job-1/stream")).text)
    failed = next(f["data"] for f in frames if f["data"].get("eventKind") == "run.failed")
    assert failed["display"]["summary"] == "api_key=[REDACTED] upstream 500"


async def test_cancel_stops_the_hermes_run_and_interrupts_the_job(api, fake_hermes):
    await submit(api, "job-1")
    run_id = await fake_hermes.wait_for_run()

    response = await api.post("/v1/jobs/async/job/job-1/cancel")
    assert response.json() == {"job_id": "job-1", "status": "interrupted", "cancelled": True}
    job = await wait_for(api, "job-1", "interrupted")
    assert job["error"] == "cancelled by user"
    async with asyncio.timeout(5):
        while run_id not in fake_hermes.stops:
            await asyncio.sleep(0.01)
    assert (await api.post("/v1/jobs/async/job/job-1/cancel")).status_code == 409


async def test_a_full_queue_answers_429_with_retry_after(api, fake_hermes):
    for n in range(5):  # one running and four queued
        assert (await submit(api, f"job-{n}")).status_code == 200

    response = await submit(api, "job-5")
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "30"

    assert (await api.post("/v1/jobs/async/job/job-4/cancel")).json()["cancelled"] is True  # a queued job
    assert (await submit(api, "job-5")).status_code == 200


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"data_sources": ["nope"]}, 422),
        ({"input": "   "}, 422),
        ({"input": "x" * 32_769}, 413),
    ],
)
async def test_submit_rejects_bad_requests(api, body, status):
    assert (await submit(api, "job-1", **body)).status_code == status


async def test_submit_rejects_a_malformed_job_id_or_conversation_id(api):
    assert (await submit(api, "bad id")).status_code == 422
    body = {"input": "q", "job_id": "job-1"}
    response = await api.post("/v1/jobs/async/submit", json=body, headers={"conversation-id": "has spaces"})
    assert response.status_code == 422


async def test_submit_rejects_a_duplicate_job_id(api, fake_hermes):
    await submit(api, "job-1")
    assert (await submit(api, "job-1")).status_code == 409


async def test_submit_rejects_a_source_the_running_tools_cannot_serve(api, data_dir):
    manifest = data_dir / "collection-manifest.json"
    manifest.unlink()  # retrieval-index has not run, so documents cannot be searched
    response = await submit(api, "job-1", data_sources=["market_news"])
    assert response.status_code == 422
    assert response.json()["detail"]["invalid_ids"] == ["market_news"]


@pytest.mark.parametrize("path", ["", "/report", "/stream", "/stream/3", "/export", "/trace"])
async def test_unknown_jobs_are_404(api, path):
    assert (await api.get(f"/v1/jobs/async/job/missing{path}")).status_code == 404


async def test_the_trace_link_is_resolved_in_phoenix(api, upstreams, fake_hermes):
    seen: list[httpx.Request] = []

    def phoenix(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": [{"context": {"trace_id": "ab" * 16, "span_id": "cd" * 8}}]})

    upstreams["phoenix.test"] = phoenix
    await submit(api, "job-1")

    response = await api.get("/v1/jobs/async/job/job-1/trace")
    assert response.json() == {"job_id": "job-1", "trace_id": "ab" * 16, "path": f"/redirects/traces/{'ab' * 16}"}
    assert seen[0].url.path == "/v1/projects/market-analysis-agent/spans"
    assert seen[0].url.params["attribute"] == f"aiq.job.ref:{correlation_ref('job-1')}"

    upstreams["phoenix.test"] = lambda request: httpx.Response(200, json={"data": []})
    assert (await api.get("/v1/jobs/async/job/job-1/trace")).status_code == 404


async def test_the_trace_link_falls_back_to_the_session_id(api, upstreams, fake_hermes):
    """Relay exports the turn span only once the turn ends; Switchyard's spans in the trace carry the session id."""

    def phoenix(request: httpx.Request) -> httpx.Response:
        found = request.url.params["attribute"] == "session.id:job-1"
        return httpx.Response(200, json={"data": [{"context": {"trace_id": "ef" * 16}}] if found else []})

    upstreams["phoenix.test"] = phoenix
    await submit(api, "job-1")

    assert (await api.get("/v1/jobs/async/job/job-1/trace")).json()["trace_id"] == "ef" * 16


@pytest.fixture
async def orphan(settings) -> None:
    """A job a previous API process was running when it died; requested before the app starts."""
    store = JobStore(settings.api_db_path)
    await store.create("orphan", {"question": "q"})
    await store.transition("orphan", expected={JobStatus.SUBMITTED}, to=JobStatus.RUNNING)
    await store.bind_run("orphan", "run-from-before")


async def test_restart_fails_jobs_the_previous_process_left_running(orphan, api, fake_hermes):
    job = (await api.get("/v1/jobs/async/job/orphan")).json()

    assert (job["status"], job["error"]) == ("failure", API_RESTARTED)
    assert fake_hermes.stops == ["run-from-before"]


async def test_a_follow_up_carries_the_earlier_answers_of_its_conversation(api, fake_hermes):
    await submit(api, "job-1")
    fake_hermes.finish(await fake_hermes.wait_for_run(), events=[event("run.completed")], output="First answer.")
    await wait_for(api, "job-1", "success")

    await submit(api, "job-2", input="And after that?")
    await fake_hermes.wait_for_run(2)

    payload = fake_hermes.runs["run-2"]["payload"]
    assert payload["input"] == "And after that?"
    assert payload["conversation_history"] == [
        {"role": "user", "content": "Which filings mention outages?"},
        {"role": "assistant", "content": "First answer."},
    ]


async def test_health_reports_the_store_and_the_runner(api):
    assert (await api.get("/health")).json() == {"status": "ok"}
