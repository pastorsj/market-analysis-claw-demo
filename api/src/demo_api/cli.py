# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""``demo-api record``: ask the pack's questions on a running stack and write the replay bundle.

The v2 bundle, which the UI replays from ``data/packs/<pack>/recordings/``::

    index.json             {schemaVersion: 2, pack: {id, version}, recordedAt,
                            sessions: [{id, title, featured, turns: [{jobId, question}]}]}
    pack.json              a copy of /data/active/pack.json, so replay needs no API
    sessions/<id>.json     {schemaVersion: 2, id, title, turns: [<GET .../job/{id}/export>]}

Each pack question becomes one single-turn session, asked one at a time. A question that does
not succeed is left out of the bundle and makes the command exit 1.
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
    return client.get(f"/v1/jobs/async/job/{job_id}/export").raise_for_status().json()


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
    args = parser.parse_args(argv)

    with httpx.Client(base_url=args.api_url, timeout=30.0) as client:
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
