<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Job API

A FastAPI service (`demo_api`) between the UI and the agent. It turns each question into a job, runs
the job on Hermes through the Hermes Runs API, stores what happens as `execution.v2` events, and
serves the answer, its evidence and a read-only view of the pack's database.

```text
UI ──/api/v1 proxy──▶ API ──Runs API──▶ hermes-gateway ──▶ Hermes (OpenShell sandbox)
                       ▲                                        │
                       └──── /internal/hermes (receipts plugin) ◀┘
```

## How a job runs

1. `POST /v1/jobs/async/submit` checks the selected sources and queues the job. One job runs at a time
   and four more may wait; a sixth live job gets `429` with `Retry-After`.
2. The runner starts a Hermes run (`src/demo_api/jobs/executor.py`). The request follows the
   agent's "Run contract" (`agent/README.md`): model `enterprise-research`, `session_id` = job id,
   `aiq.*` metadata that joins the Phoenix trace, and `enabled_toolsets` = `skills` plus the MCP
   servers of the selected sources' families. Earlier answers of the same conversation go along as
   history.
3. Each Hermes event becomes one `execution.v2` event (`hermes/normalizer.py`). The agent's
   `execution-receipts` plugin posts one receipt per data-tool call to
   `/internal/hermes/jobs/{id}/tool-receipts`; the API stores it once and adds one event that points at it.
4. When the run completes, the API waits up to `HERMES_RECEIPT_SETTLE_SECONDS` for every tool call's
   receipt, turns the agent's `[evidence:<receipt id>]` tokens into numbered citations with a Sources
   list (`reports/publication.py`), and stores the report with `success` in one transaction.

A job fails with a message the UI can show when Hermes fails, a progress budget runs out (idle,
no progress, tool calls, repeated events), or the 1,200 s job deadline passes; the Hermes run is
stopped in every case. Cancelling a queued job means it never starts. Cancelling a running job asks
Hermes to stop the run before the API stops listening to it. When the API starts, it fails every
job a previous process left unfinished ("The API restarted before this job finished; please
retry.") and stops its Hermes run. Finished jobs are deleted after `JOB_RETENTION_SECONDS`.

The queue and the cancel signals live in the process, so run **one** uvicorn worker. Jobs, events
and receipts are in SQLite (WAL) at `API_DB_PATH`; all database work runs in threads.

On `SIGTERM` uvicorn waits at most 3 s (`--timeout-graceful-shutdown` in the `Dockerfile`) for open
event streams, which browsers resume from their cursor. Then the runner fails live jobs and asks
Hermes to stop their runs, waiting up to 10 s. The container therefore needs a stop grace of about
30 s (`stop_grace_period` in `compose.yaml`) before Docker kills it.

## Routes

| Route | Purpose |
|---|---|
| `GET /health` | 200 while the store answers and the job workers run |
| `GET /v1/pack` | Title, disclaimer and questions of the active pack |
| `GET /v1/data_sources` | Sources the running tools can serve, with their capabilities |
| `GET /v1/data_sources/{id}/schema` | Tables, views, columns, keys and relationships |
| `GET /v1/data_sources/{id}/preview?table=&limit=` | First rows (at most 100) |
| `POST /v1/data_sources/{id}/query` `{sql}` | One SELECT over the database, in a separate process: 5 s, 100 rows, 2 at a time |
| `GET /v1/data_sources/{id}/ontology` | Auto Ontology graph (ontology profile; 404 otherwise) |
| `POST /v1/jobs/async/submit` | `{input, data_sources?, job_id?}`, header `conversation-id` → `{job_id, status}` |
| `GET /v1/jobs/async/job/{id}` | `{job_id, status, error, created_at}` |
| `GET /v1/jobs/async/job/{id}/report` | `{job_id, has_report, report}` |
| `POST /v1/jobs/async/job/{id}/cancel` | `{job_id, status: "interrupted", cancelled: true}`; 409 once finished |
| `GET /v1/jobs/async/job/{id}/stream[/{cursor}]` | Server-Sent Events (below) |
| `GET /v1/jobs/async/job/{id}/trace` | `{trace_id, path}`: the job's trace in Phoenix |
| `GET /v1/jobs/async/job/{id}/export` | The job as one turn of the recordings bundle |
| `GET /internal/hermes/jobs/{id}/execution-scope` | Plugin: the job's sources, database, collection and model tiers |
| `POST /internal/hermes/jobs/{id}/tool-receipts` | Plugin: one `ReceiptV2` |
| `POST /internal/hermes/jobs/{id}/llm-calls` | Plugin: one model call, with the served model and its tier |

Unknown jobs, and jobs deleted by retention, are 404. `/internal/hermes/**` needs the `X-Receipt-Key`
header.

### The event stream

Stored events are sent with their store cursor as the SSE `id:`; frames the stream makes up
(`stream.start`, `stream.mode`, `job.status`) have no id, so a browser that reconnects with
`Last-Event-ID` never skips a stored event. The stream replays stored events, sends
`stream.mode: live`, polls every 0.5 s (with a keepalive comment every 15 s), and ends with a
`job.status` frame once the job is finished (`reconnected: true` on a resumed stream). Execution
events are `execution.v2` (`contracts/README.md`); the answer is an `artifact.update` with
`output_category: final_report`.

## Recordings

`demo-api record` asks the pack's featured questions (`--all` for every one, `--question ID` for
some) on a running stack and writes the bundle the UI replays:

```text
data/packs/<pack>/recordings/
  index.json          {schemaVersion: 2, pack: {id, version}, recordedAt, sessions: [{id, title, featured, turns: [{jobId, question}]}]}
  pack.json           copy of /data/active/pack.json
  sessions/<id>.json  {schemaVersion: 2, id, title, turns: [<export>]}
```

An export turn is `{jobId, question, submittedAt, completedAt, status, report: {markdown, citations[]} | null,
events: [execution.v2], receipts: [ReceiptV2], sourceIds}`. `scripts/demo.sh record` runs the command in
the api image on the stack's network, where the defaults (`--api-url http://api:8000`,
`DATA_ACTIVE_DIR=/data/active`) are right. A question that does not succeed is left out, and the
command exits 1.

## Environment

Secrets can also be files in `/run/secrets` named after the setting (Compose secrets).

| Variable | Default | Meaning |
|---|---|---|
| `HERMES_URL` | `http://hermes-gateway:8642` | Hermes Runs API |
| `HERMES_API_SERVER_KEY` | – (secret) | Bearer key of the Hermes API server |
| `HERMES_RECEIPT_API_KEY` | – (secret) | `X-Receipt-Key` of the internal routes |
| `AGENT_FEATURES` | `retrieval,analytics` | Tool groups in the agent image (as its build argument); limits capabilities and toolsets |
| `AGENT_EFFICIENT_MODEL`, `AGENT_CAPABLE_MODEL` | empty | Switchyard's model ids, for the tier of each model call |
| `DATA_ACTIVE_DIR` | `/data/active` | The built data pack |
| `API_DB_PATH` | `/var/lib/demo-api/jobs.db` | SQLite job store |
| `JOB_MAX_ACTIVE`, `JOB_MAX_QUEUED` | `1`, `4` | Queue size |
| `JOB_DEADLINE_SECONDS` | `1200` | Per-job backstop deadline |
| `JOB_RETENTION_SECONDS` | `86400` | How long finished jobs are kept |
| `HERMES_RUN_WALL_TIMEOUT_SECONDS` | `900` | Hermes run deadline |
| `HERMES_RUN_IDLE_TIMEOUT_SECONDS`, `HERMES_RUN_NO_PROGRESS_TIMEOUT_SECONDS` | `600`, `600` | Progress budgets; a judged model reply can stay silent for minutes |
| `HERMES_RUN_MAX_TOOL_CALLS`, `HERMES_RUN_MAX_DUPLICATE_EVENTS` | `128`, `64` | Progress budgets |
| `HERMES_RUN_STOP_GRACE_SECONDS`, `HERMES_RUN_POLL_INTERVAL_SECONDS` | `30`, `1` | Stopping and polling a run |
| `HERMES_HEARTBEAT_SECONDS` | `15` | Progress heartbeat while a run is silent |
| `HERMES_RECEIPT_SETTLE_SECONDS` | `2` (at most 5) | Wait for the last receipts |
| `AIQ_PHOENIX_INTERNAL_URL`, `PHOENIX_PROJECT` | `http://phoenix:6006`, `market-analysis-agent` | Trace lookup |
| `AUTO_ONTOLOGY_URL`, `AUTO_ONTOLOGY_EMAIL`, `AUTO_ONTOLOGY_PASSWORD` | empty | Ontology view; an empty URL turns it off |
| `AUTO_ONTOLOGY_ORIGIN` | `AUTO_ONTOLOGY_URL` | The `Origin` Auto Ontology's sign-in trusts |
| `TOOL_REGISTRY_FILE` | `contracts/tool-registry.json` | Set by the image |

## Run and test

```bash
uv run --directory api pytest                     # offline: fake Hermes, Phoenix and Auto Ontology
docker build --build-context contracts=contracts -t market-demo/api:local api
scripts/demo.sh record                            # record the featured questions on the running stack
```

`tests/jobs/test_runner.py` pins the job semantics the prototype got from Dask and NAT: order, the
queue cap, cancelling queued and running jobs, the deadline, progress budgets, restart recovery,
shutdown and retention. The contract models in `src/demo_api/events/` and `receipts/` feed
`scripts/gen-contracts.sh`.
