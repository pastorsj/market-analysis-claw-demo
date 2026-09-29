<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Retrieval

Document questions go to one MCP tool, `retrieve_evidence`, served by `tools/retrieval`. It embeds and
reranks with NVIDIA Nemotron retrieval models through LangChain's NVIDIA partner package, and stores vectors
in Milvus through plain `pymilvus`. There is no LlamaIndex, no LangChain agent and no LangGraph: Hermes is the
only agent, and LangChain is used only for its NVIDIA embed and rerank clients.

| Piece | Version |
|---|---|
| `langchain-nvidia-ai-endpoints` (`NVIDIAEmbeddings`, `NVIDIARerank`) | 1.4.3, exact pin |
| `langchain-text-splitters` (`RecursiveCharacterTextSplitter`) | 1.x |
| `pymilvus` | 2.6.17 |
| Milvus | 2.6.25, CPU standalone: embedded etcd, local storage, no MinIO |
| Embed model | `nvidia/nemotron-3-embed-1b` |
| Rerank model | `nvidia/llama-nemotron-rerank-vl-1b-v2` |

The component's README, [`tools/retrieval/README.md`](../tools/retrieval/README.md), has the environment, the
data contract and the result schema.

## Pipeline

**Index (`retrieval-index`, a one-shot under the retrieval profile).**
1. Read `/data/active/corpus/documents.jsonl`, which `data-corpus` builds from the pack's corpora.
2. Split each document into chunks of up to 2,400 characters with a 240-character overlap.
3. Embed the chunks as passages, 50 per request.
4. Load them into a new Milvus collection named `<alias>__<fingerprint>`, point the alias at it when it is
   complete, drop older builds, and write `/data/active/collection-manifest.json`.

The fingerprint covers the corpus bytes, the embed URL and model, the chunking and the index parameters.
Re-running the index on unchanged input does nothing, and a changed input builds a new collection while the
server keeps answering from the previous one. The default pack indexes about 5,200 documents
(SEC EDGAR filings and eCFR Title 17) as about 23,600 chunks.

**Search (`retrieval`, `127.0.0.1:8120/mcp`).** `retrieve_evidence(query, source_ids, top_k=8)`, with `top_k`
at most 25:
1. Embed the query once.
2. Search every selected source for the same share of candidates, `min(4 × top_k, 200 ÷ sources)`, in the
   build the alias points at (resolved once per call).
3. Rerank all candidates together in one request and return the best `top_k` passages with their title, URL,
   date, scores and metadata, plus the models, the index settings and timings.

The Hermes plugin sets `source_ids` to the job's selected document sources, and the tool refuses any source
the pack does not declare as documents. Each call becomes a `retrieval_evidence` receipt, which the UI's
retrieval explorer shows.

## Endpoints

Retrieval uses the retriever endpoint (`RETRIEVER_*`), never the inference endpoint. Rerank requests go to the
first of these that applies:

1. `RETRIEVER_RERANK_URL`, if set (for example a self-hosted NIM's `http://<host>:8000/v1/ranking`);
2. the model's hosted endpoint, when the base URL is build.nvidia.com (the default);
3. `{RETRIEVER_BASE_URL}/ranking`, the self-hosted NIM path.

An OpenAI-compatible gateway that serves the agent's models may have no route for the VL reranker, which is
why the retriever has its own endpoint and defaults to build.nvidia.com whatever serves the agent's models.

## Documented configuration items

The integration has no code workarounds: no subclass, no private attribute, no monkeypatch. It needs these
configuration choices, all through public API:

| # | Choice | Why | Where |
|---|---|---|---|
| 1 | Register `nvidia/nemotron-3-embed-1b` with `register_model` | 1.4.3's model table does not list it. Without an entry, constructing the client runs a blocking `GET /v1/models` lookup | `nvidia.py` |
| 2 | Pass `base_url` explicitly to every client | The package's default comes from `NVIDIA_BASE_URL`, which would leak in from other software. This repository never uses `NVIDIA_BASE_URL` | `nvidia.py` |
| 3 | Pass `api_key` explicitly, and refuse to start without one | An empty key falls back to `NVIDIA_API_KEY`. That is also why the `.env` names are `INFERENCE_*` and `RETRIEVER_*` | `nvidia.py`, `settings.py` |
| 4 | Rerank with `top_n = max_batch_size = 200` | Search never collects more than 200 candidates, so reranking is always one request (the default batch of 32 would split it) | `nvidia.py` |
| 5 | Accept the clients' fixed 60 s timeout | 1.4.3 ignores a `timeout` argument | – |
| 6 | Retry transient failures around every embed and rerank call | The clients have no retries. A tool call gets 3 attempts; the index build gets 8 with 0.5–8 s of jittered backoff. Dropped connections, timeouts, 408, 429 and 5xx are retried, including the async client's `[###] Unknown Error` for a non-JSON error page | `nvidia.py` |
| 7 | Emit three OpenInference spans: `embed`, `search`, `rerank` | LangChain's instrumentation emits nothing for direct embed and rerank calls | `search.py` |
| 8 | Pin `==1.4.3` and set `NVIDIA_USAGE_TELEMETRY_ENABLED=false` | The next release turns usage telemetry on by default; 1.4.3 is also the floor for GHSA-g28h-2cmm-rj9x | `pyproject.toml`, `__init__.py` |
| 9 | Reserve the document metadata key `image` | `NVIDIARerank` would send it to the reranker as an image. The index build rejects documents that use it | `datapack.py` |

Paths are under `tools/retrieval/src/demo_retrieval/`. Items 1 and 5 can go once the package lists the model
and honours `timeout`.

Two related details:
- Both clients set `truncate="END"`, so an over-long passage is cut rather than rejected.
- With `RETRIEVER_RERANK_URL` set, the reranker is registered with that URL and built with the build.nvidia.com
  base URL, because the client honours a registered endpoint only in hosted mode. No request goes to the base
  URL itself.

**Milvus.** An explicit schema: `chunk_id` primary key; `source_id` as the partition key; `document_id`,
`title`, `url`, `published_at` and `text` columns; an `embedding` vector; dynamic fields for each source's own
metadata. The index is HNSW with cosine similarity, `M = 16`, `efConstruction = 200`, and searches use
`ef = 128`, above the largest per-source candidate count (100).

## Result size

A passage is at most 2,400 characters, and each hit adds about 1 KB of ids, URL and metadata. The MCP SDK
sends a result twice (structured content and the same JSON as text), and Hermes gives the model one copy.

| `top_k` | One copy | JSON-RPC response |
|---|---|---|
| 3 | 11 KB | 21 KB |
| 8 (default) | 27 KB | 53 KB |
| 25 | 83 KB | 164 KB |

OpenShell 0.1.2 caps MCP JSON-RPC request bodies at 64 KiB, not responses, so these pass. The receipt cuts
each passage to 1,500 characters for the UI.

## Operating it

```bash
./scripts/demo.sh data reindex    # rebuild the index, e.g. after changing the embed model or base URL
./scripts/demo.sh logs retrieval  # the server's log
```

A reindex builds a new collection and moves the alias only when it is complete, so the running server keeps
answering. The spans appear under the job's trace in Phoenix ([operations](operations.md#phoenix)).
