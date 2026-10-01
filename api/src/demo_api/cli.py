# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""``demo-api record``: ask the pack's questions on a running stack and write the replay bundle.

The v2 bundle, which the UI replays from ``data/packs/<pack>/recordings/``::

    index.json             {schemaVersion: 2, pack: {id, version}, recordedAt,
                            sessions: [{id, title, featured, turns: [{jobId, question}]}]}
    pack.json              a copy of /data/active/pack.json, so replay needs no API
    sessions/<id>.json     {schemaVersion: 2, id, title, turns: [<GET .../job/{id}/export>]}
    database.json          {schemaVersion: 1, sources: [{id, name, databaseName, schema, previews, queries}]}:
                           each structured source's schema (GET .../schema), the first rows of each table
                           (GET .../preview), and the result (POST .../query) of each SQL query the recorded
                           answers ran and of the data viewer's starting query for each table, so the data
                           viewer works in replay

Each pack question becomes one single-turn session, asked one at a time. After an answer that
called market analytics tools, the recorder asks for its CPU/GPU comparison
(POST .../benchmark), which the export then carries; on a CPU-only stack there is none. A
question that does not succeed is left out of the bundle and makes the command exit 1.

``demo-api snapshot-database --out <recordings>`` rewrites only ``database.json`` of a bundle.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import uuid
from datetime import UTC
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from .settings import Settings

POLL_SECONDS = 2.0
PREVIEW_ROWS = 8  # the rows the data viewer previews (ui/src/features/execution/data-viewer)
# The query the data viewer's SQL tab starts from for a table (DatabaseBrowser.tsx), so replay can run it too
DEFAULT_TABLE_SQL = 'SELECT * FROM "{schema}"."{table}" LIMIT 25'
BENCHMARK_TIMEOUT_SECONDS = 900.0


def record(
    client: httpx.Client, *, data_dir: Path, out_dir: Path, question_ids: list[str], featured_only: bool, timeout: float
) -> int:
    pack = client.get("/v1/pack").raise_for_status().json()

    def wanted(question: dict[str, Any]) -> bool:
        if question_ids:
            return question["id"] in question_ids
        return question["featured"] or not featured_only

    questions = [question for question in pack["questions"] if wanted(question)]
    if not questions:
        print("No pack questions match; nothing to record.", file=sys.stderr)
        return 1
    (out_dir / "sessions").mkdir(parents=True, exist_ok=True)
    sessions: list[dict[str, Any]] = []
    failures = 0
    for question in questions:
        print(f"Asking {question['id']}: {question['question']}", file=sys.stderr)
        turn = _ask(client, question, timeout=timeout)
        if turn["status"] != "success":
            print(f"  {turn['status']}; left out of the bundle", file=sys.stderr)
            failures += 1
            continue
        session = {"schemaVersion": 2, "id": question["id"], "title": question["label"], "turns": [turn]}
        _write_json(out_dir / "sessions" / f"{question['id']}.json", session)
        sessions.append(
            {
                "id": question["id"],
                "title": question["label"],
                "featured": question["featured"],
                "turns": [{"jobId": turn["jobId"], "question": turn["question"]}],
            }
        )
    shutil.copyfile(data_dir / "pack.json", out_dir / "pack.json")
    snapshot_database(client, out_dir)
    index = {
        "schemaVersion": 2,
        "pack": {"id": pack["id"], "version": pack["version"]},
        "recordedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "sessions": sessions,
    }
    _write_json(out_dir / "index.json", index)
    print(f"Recorded {len(sessions)} of {len(questions)} questions into {out_dir}", file=sys.stderr)
    return 1 if failures else 0


def _ask(client: httpx.Client, question: dict[str, Any], *, timeout: float) -> dict[str, Any]:
    job_id = str(uuid.uuid4())
    body = {
        "agent_type": "hermes",
        "input": question["question"],
        "data_sources": question["sources"],
        "job_id": job_id,
    }
    headers = {"conversation-id": f"record-{job_id}"}
    client.post("/v1/jobs/async/submit", json=body, headers=headers).raise_for_status()
    deadline = time.monotonic() + timeout
    while True:
        status = client.get(f"/v1/jobs/async/job/{job_id}").raise_for_status().json()
        if status["status"] not in {"submitted", "running"}:
            break
        if time.monotonic() > deadline:
            client.post(f"/v1/jobs/async/job/{job_id}/cancel")
            break
        time.sleep(POLL_SECONDS)
    if status.get("error"):
        print(f"  error: {status['error']}", file=sys.stderr)
    if status["status"] == "success":
        _benchmark(client, job_id)
    return client.get(f"/v1/jobs/async/job/{job_id}/export").raise_for_status().json()


def _benchmark(client: httpx.Client, job_id: str) -> None:
    """Compare the answer's market calls on the CPU and the GPU; a run without any, or a CPU-only stack, has none."""
    response = client.post(f"/v1/jobs/async/job/{job_id}/benchmark", timeout=BENCHMARK_TIMEOUT_SECONDS)
    if response.status_code == 422:
        return
    body = response.json() if response.status_code == 200 else {}
    print(f"  benchmark: {body.get('status', response.status_code)}", file=sys.stderr)


def snapshot_database(client: httpx.Client, out_dir: Path) -> None:
    """Write ``database.json``: what the data viewer shows of each structured source, from the running API."""
    queries: set[tuple[str, str]] = set()
    for path in sorted((out_dir / "sessions").glob("*.json")):
        for turn in json.loads(path.read_text(encoding="utf-8"))["turns"]:
            for receipt in turn["receipts"]:
                content = receipt.get("content") or {}
                if receipt.get("artifactKind") == "structured_query" and content.get("sql"):
                    queries.add((content["databaseName"], content["sql"]))
    sources = []
    for source in client.get("/v1/data_sources").raise_for_status().json():
        if not source.get("database_name"):
            continue
        base = f"/v1/data_sources/{source['id']}"
        schema = client.get(f"{base}/schema").raise_for_status().json()
        previews = {
            table["name"]: client.get(f"{base}/preview", params={"table": table["name"], "limit": PREVIEW_ROWS})
            .raise_for_status()
            .json()
            for table in schema["tables"]
        }
        results = []
        defaults = [
            DEFAULT_TABLE_SQL.format(schema=table["schema"], table=table["name"].rsplit(".", 1)[-1])
            for table in schema["tables"]
        ]
        recorded = sorted(sql for database, sql in queries if database == source["database_name"])
        for sql in dict.fromkeys([*recorded, *defaults]):
            response = client.post(f"{base}/query", json={"sql": sql})
            if response.status_code == 200:
                results.append({"sql": sql, "result": response.json()})
            else:
                print(
                    f"  a recorded query did not run ({response.status_code}); replay cannot rerun it", file=sys.stderr
                )
        sources.append(
            {
                "id": source["id"],
                "name": source["name"],
                "databaseName": source["database_name"],
                "schema": schema,
                "previews": previews,
                "queries": results,
            }
        )
    _write_json(out_dir / "database.json", {"schemaVersion": 1, "sources": sources})


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="demo-api", description="Job API tools.")
    commands = parser.add_subparsers(dest="command", required=True)
    record_parser = commands.add_parser("record", help="record the pack's questions as a v2 replay bundle")
    record_parser.add_argument("--api-url", default="http://api:8000", help="the running API (default: on the stack)")
    record_parser.add_argument("--out", type=Path, required=True, help="the pack's recordings directory")
    record_parser.add_argument("--data-dir", type=Path, help="the active pack (default: DATA_ACTIVE_DIR)")
    record_parser.add_argument("--question", action="append", default=[], help="a question id (repeatable)")
    record_parser.add_argument("--all", action="store_true", help="every question, not only the featured ones")
    record_parser.add_argument("--timeout", type=float, default=1_500, help="seconds to wait for one answer")
    snapshot_parser = commands.add_parser("snapshot-database", help="rewrite a bundle's database.json")
    snapshot_parser.add_argument("--api-url", default="http://api:8000", help="the running API (default: on the stack)")
    snapshot_parser.add_argument("--out", type=Path, required=True, help="the pack's recordings directory")
    args = parser.parse_args(argv)

    with httpx.Client(base_url=args.api_url, timeout=30.0) as client:
        if args.command == "snapshot-database":
            snapshot_database(client, args.out)
            return 0
        return record(
            client,
            data_dir=args.data_dir or Settings().data_active_dir,
            out_dir=args.out,
            question_ids=args.question,
            featured_only=not args.all,
            timeout=args.timeout,
        )


if __name__ == "__main__":
    sys.exit(main())
