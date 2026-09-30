<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Decisions

The choices that shape this repository, and the workarounds they required. The demo was rebuilt from an
earlier AI-Q prototype; decisions dated 2026-09-29 were made for that rebuild.

## Decision log

| # | Decision | Why | Where |
|---|---|---|---|
| 1 | Hermes Agent is the only agent, running in an OpenShell 0.1.2 sandbox built only from official artifacts (images by digest, CLI by checksum), with the release pinned in one file | A real sandbox boundary without a custom controller: about 400 lines of configuration and script replace roughly 5,500 to 6,000 lines of controller and VM integration | `infra/openshell/`, `agent/`, [OpenShell](openshell.md) |
| 2 | Two endpoints, inference and retriever, each with its own base URL and key (the retriever key defaults to the inference key, so one build.nvidia.com key serves both); never `NVIDIA_API_KEY` or `NVIDIA_BASE_URL` | An OpenAI-compatible inference endpoint may serve the agent's models but not the VL reranker. Hermes and LangChain read the `NVIDIA_*` names as global defaults, so they would leak between services | `.env.example`, [configuration](configuration.md) |
| 3 | Switchyard 0.3.0 runs outside the sandbox and is the only holder of the model keys on the agent path. The capable model may have its own endpoint and key (`CAPABLE_BASE_URL`, `CAPABLE_API_KEY`) | The sandbox never sees a model key, the model choice changes without rebuilding the sandbox, and GPT-6 Sol can come from any OpenAI-compatible provider | `infra/switchyard/` |
| 4 | The default is Nemotron 3 Ultra alone on build.nvidia.com (`passthrough.nemotron`); with a provider that serves GPT-6 Sol, Sol pinned (`pinned-capable.nemotron-gpt`), not Ultra escalating to Sol | The 2026-09-30 bake-off on both packs (34 runs per arm): Sol pinned passed 24, Ultra → Sol with the tuned judge 20, Ultra alone 13, Super → Ultra 12 (twice as slow, 4 failed jobs), confirming the 2026-09-29 one. build.nvidia.com serves no GPT model. Nemotron 3.5 Super becomes the efficient model once it is ready; its text preview passed 4 | [Models and routing](models-and-routing.md) |
| 5 | Retrieval on `langchain-nvidia-ai-endpoints` 1.4.3 (embed and rerank clients only) and plain `pymilvus` 2.6 on CPU Milvus 2.6. No LlamaIndex, no LangChain agents, no LangGraph | Zero code workarounds and nine documented configuration items; LlamaIndex needed two code workarounds and could not reach zero | `tools/retrieval/`, [retrieval](retrieval.md) |
| 6 | A plain FastAPI job service. NAT and Dask are removed; an asyncio runner on SQLite (WAL) keeps what Dask provided: one running and four queued jobs, a 1,200 s deadline, cancellation of queued and running jobs, restart recovery and retention | The job path used Dask only for serialization and queued-job cancellation. Its cancel did not stop a running job, and a worker crash re-ran the job. The runner keeps the needed semantics, pinned by `tests/jobs/test_runner.py`, with one uvicorn worker because the queue lives in the process | `api/` |
| 7 | The UI is the upstream AI-Q UI (at `bf4e67d1`) re-applied, plus a contract-first execution feature. `@xyflow/react` is pinned exactly at 12.12.0 with our own layered layout. The product name and title stay "Enterprise Research" | A small, reviewable diff from upstream; the graph library passed a safety review with explicit node sizes, one CSS import and dynamic loading | `ui/UPSTREAM.md`, `ui/src/features/execution/` |
| 8 | Phoenix is private (loopback only) and receives full trace payloads straight from Relay, with no allowlist and no collector | The allowlist existed to protect a Phoenix that others could reach; OpenShell does not cap OTLP bodies | `agent/profile/relay-plugins.toml`, [operations](operations.md#phoenix) |
| 9 | One lifecycle script, `scripts/demo.sh`, and no Makefile | The bring-up must be ordered around the sandbox, which Compose does not manage | `scripts/` |
| 10 | Data content is unchanged from the prototype, behind a data-pack contract (`data/packs/<id>/`, `DATA_PACK`, `/data/active`) | Swapping the data means adding a pack, not editing services | `data/`, [data packs](data-packs.md) |
| 11 | Services share JSON contracts only: a tool registry, and event and receipt types generated from the API's Pydantic models into JSON Schema and TypeScript | One definition per tool and per event; `--check` catches drift in CI | `contracts/`, `scripts/gen-contracts.sh` |
| 12 | The job's source scope is injected into tool arguments by the plugin's `pre_tool_call` hook; tools filter on `source_ids` | Replaces signed scope grants with an argument the tools already take | `agent/profile/plugins/`, `api/src/demo_api/routes/internal.py` |
| 13 | The plugin reports each model call to `POST /internal/hermes/jobs/{id}/llm-calls` | The only path for the served model and tier to reach the UI | `infra/openshell/providers/receipts.yaml` |
| 14 | Receipts fail closed: a registered tool call with no receipt fails the job | An answer must never cite evidence that was not recorded | `api/src/demo_api/jobs/executor.py` |
| 15 | Kumo prediction is a tool on the market-analytics server (`predict_asset_outcomes`), backed by a local Kumo Relational NIM or a hosted endpoint | Prediction does not depend on Auto Ontology, and the kumo profile does not need it | `tools/market-analytics/` |
| 16 | Auto Ontology is optional: a private submodule (`update = none`) plus three patches, run in trusted service mode on loopback only. Publishing the patches needs release approval, and its images bundle private wheels (`kumorfm`, `nvidia_sdfm`), so they stay local | Structured SQL answers where access exists, without blocking anyone else | `tools/auto-ontology/` |
| 17 | The replay bundle (v2) is committed with its pack, and the UI replays it without the API | The demo can be shown with no keys, no GPU and no network access to the endpoints | `data/packs/<id>/recordings/` |
| 18 | One `uv` project and `uv.lock` per service, Python 3.12, one `ruff.toml`; no root workspace | Services resolve their dependencies independently (RAPIDS, DuckDB and Auto Ontology pins do not collide) | every service directory |
| 19 | Trimmed rigor: unit and contract tests per project, a skills lint, Switchyard template dry-runs, Compose config checks, a replay e2e and one CI workflow. Contributor and security notes live in the README and [architecture](architecture.md) | Enough to keep a demo correct, without a release process | `.github/workflows/ci.yml` |

## Documented workarounds

Each entry is a deliberate deviation from what the upstream project would suggest, with the condition that
removes it.

| Workaround | Why | Where | Remove when |
|---|---|---|---|
| Hermes patch 0001: forward run metadata into the Relay turn | Joins Phoenix traces to jobs | `agent/patches/` | A released Runs API forwards request metadata |
| Hermes patch 0002: exact per-run toolsets | Each job gets only its sources' tools and cannot widen them | `agent/patches/` | A released Runs API accepts a non-widening per-run toolset list |
| Hermes patch 0003: `tool_call_id` on tool events | Joins graph nodes to receipts | `agent/patches/` | A released Runs API emits it on both events |
| Hermes patch 0004: read `read_only_hint` from mcp 2.x annotations | Otherwise every data tool counts as write-capable, and a call cut off by a server restart fails instead of being replayed | `agent/patches/` | Hermes reads the mcp 2.x name |
| Seed `HERMES_HOME` at build time | OpenShell ignores the image's entrypoint, so Hermes' init never runs | `agent/Dockerfile` | – (a property of OpenShell) |
| The plugin records a receipt in whichever of `transform_tool_result` and `post_tool_call` fires first | Hermes' agent loop runs `transform_tool_result` first, so a receipt posted in `post_tool_call` came too late to cite | `agent/profile/plugins/execution_receipts/` | Hermes fires the hooks in one order |
| `HERMES_STREAM_READ_TIMEOUT=900`, `HERMES_STREAM_STALE_TIMEOUT=600` | An escalation template buffers judged replies, so a reply can stay silent for minutes | `agent/Dockerfile` | – |
| NeMo Relay pinned below 0.9 (the build fails otherwise) | 0.9 needs a collector to export to Phoenix from the sandbox | `agent/Dockerfile` | Relay exports plain OTLP/HTTP from the sandbox again |
| `API_SERVER_KEY` is a real value in the sandbox, not a provider placeholder | Hermes checks it on inbound requests; placeholders resolve only on outbound ones | `scripts/lib/openshell.sh` | OpenShell resolves placeholders for inbound checks |
| Record and remove the sandbox's anonymous volumes | OpenShell 0.1.2 deletes sandbox containers without them | `scripts/lib/openshell.sh` | OpenShell removes them |
| Phoenix runs through `infra/phoenix/serve.py`, which defaults uvicorn's keep-alive to 120 s (Phoenix has no setting for it) | OpenShell 0.1.2's proxy fails the first request on a connection the server closed as idle, and Relay does not retry, so traces lost spans | `infra/phoenix/serve.py` | The proxy closes the sandbox side too, or Relay retries |
| The trace lookup falls back from `aiq.job.ref` to `session.id` | While a turn runs, Relay has not exported the span carrying `aiq.job.ref`; Switchyard's spans carry the job id | `api/src/demo_api/phoenix.py` | – |
| Switchyard and retrieval spans name the agent's Phoenix project | Phoenix files a trace under the project of its first span, which is often Switchyard's | `compose.yaml` | – |
| Switchyard runs standalone, built from crates.io | NeMo Relay's Switchyard plugin does not pass the session id the escalation latch needs, and there is no official image | `infra/switchyard/Dockerfile` | Relay passes the session id; an official image exists |
| Switchyard's root filesystem is not read-only (uid 1000, no capabilities instead) | Compose writes environment-sourced secrets into the container, which a read-only root refuses | `compose.yaml` | Compose mounts such secrets without writing |
| The forwarder's health check probes `/health` | `/v1/capabilities` without the key made Hermes log a rejected key every 5 s | `compose.yaml` | – |
| Builds turn off provenance attestations, Dockerfiles have no `EXPOSE`, and an image shared by several services is built by one of them | Otherwise every build gives an unchanged image a new ID, and `up` recreates containers and the sandbox | `scripts/lib/common.sh`, Dockerfiles, `compose.yaml` | BuildKit and Compose give identical builds identical IDs |
| `demo.sh` passes `.env` with `--env-file` and derives `DATA_DATABASE_NAME`, `AGENT_FEATURES`, `KUMO_RELATIONAL_URL` and `AUTO_ONTOLOGY_URL` | Passing any `--env-file` turns off Compose's `.env` lookup, and Compose interpolation has no pattern substitution or conditionals | `scripts/lib/common.sh`, `scripts/lib/env.sh` | – |
| Market analytics restarts when the data one-shot is recreated | It resolves `/data/active` once at startup | `compose.yaml`, `scripts/demo.sh` | – |
| Nine retrieval configuration items (`register_model`, explicit URL and key, one rerank batch, retries, manual spans, the pin, the reserved `image` key, …) | Gaps in `langchain-nvidia-ai-endpoints` 1.4.3 | `tools/retrieval/` | See [retrieval](retrieval.md#documented-configuration-items) |
| Auto Ontology patches: hide the `prediction` schema from search, report resolution lineage, trusted service mode for MCP | Upstream cannot exclude schemas, reports no typed lineage, and its MCP server accepts only per-caller OAuth | `tools/auto-ontology/patches/` | Upstream ships each behavior |
| Every Auto Ontology model setting is explicit | Unset, upstream falls back to built-in defaults chosen by key prefix, and to `NVIDIA_API_KEY` | `compose.yaml` | – |
| The DuckDB writer is pinned to the readers' version | An older DuckDB cannot always open a newer file | `data/pyproject.toml`, `data/tests/test_duckdb_versions.py` | – |
| RAPIDS 26.06 with pandas < 2.4, pyarrow < 24 and NetworkX < 3.7 | The versions the GPU tools were validated with | `tools/market-analytics/pyproject.toml` | A newer RAPIDS is validated |
