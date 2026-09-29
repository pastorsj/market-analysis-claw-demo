<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# retrieval

The `retrieve_evidence` MCP tool. It searches the active data pack's document sources with NVIDIA Nemotron
embed and rerank models (through LangChain's `langchain-nvidia-ai-endpoints`) over Milvus.

One image, two commands:

- `demo-retrieval ingest`: the `retrieval-index` one-shot. It reads `/data/active/corpus/documents.jsonl`,
  splits documents into chunks, embeds the chunks as passages, loads them into a new Milvus collection, points
  the collection alias at it, and writes `/data/active/collection-manifest.json`.
- `demo-retrieval serve` (default): the MCP server. It uses streamable HTTP at `:8120/mcp`, has a `GET /health`
  check, and runs as the `retrieval` service.

## How it fits

Hermes (in the OpenShell sandbox) calls `mcp__retrieval__retrieve_evidence` at
`http://host.openshell.internal:8120/mcp`. The agent plugin's `pre_tool_call` hook sets `source_ids` to the
job's document sources. The tool accepts only sources that `pack.json` declares with `"kind": "documents"`.
The plugin turns each result into a `retrieval_evidence` receipt for the UI.

Each call runs the same steps:

1. Embed the query once (`input_type=query`).
2. Search every source for the same share of candidates: `min(4 × top_k, 200 ÷ sources)`.
3. Rerank all candidates together in one request. Passages carry text only.

The server sends three OpenInference spans (`embed`, `search`, `rerank`) to Phoenix. They nest under the MCP
SDK's `tools/call retrieve_evidence` span.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `RETRIEVER_BASE_URL` | `https://integrate.api.nvidia.com/v1` | build.nvidia.com, a self-hosted NIM, or another OpenAI-compatible endpoint |
| `RETRIEVER_API_KEY` | required | Or the Compose secret file `/run/secrets/retriever_api_key`. Under `demo.sh`, an empty value in `.env` means `INFERENCE_API_KEY` |
| `RETRIEVER_EMBED_MODEL` | `nvidia/nemotron-3-embed-1b` | Changing it rebuilds the index on the next `ingest` |
| `RETRIEVER_RERANK_MODEL` | `nvidia/llama-nemotron-rerank-vl-1b-v2` | |
| `RETRIEVER_RERANK_URL` | unset | Full rerank URL; see below |
| `MILVUS_URI` | `http://milvus:19530` | A local `*.db` path uses Milvus Lite (dev only) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | e.g. `http://phoenix:6006/v1/traces`; no spans are exported when unset |

`NVIDIA_BASE_URL` and `NVIDIA_API_KEY` are never read.

Rerank requests go to the first of these that applies:

1. `RETRIEVER_RERANK_URL`, if set.
2. The model's build.nvidia.com endpoint, when the base URL is build.nvidia.com.
3. `{RETRIEVER_BASE_URL}/ranking`, the self-hosted NIM path.

Another endpoint that has no route for the VL reranker needs `RETRIEVER_RERANK_URL` and a rerank model that
endpoint serves.

## Data contract

- **In:** `pack.json` supplies `sources[].id` and `sources[].kind`, and `documents.collection`, the alias name.
  The data build always writes `documents.collection` for a pack with a document corpus.
- **In:** `corpus/documents.jsonl` has one row per document:
  `{document_id, source_id, title, text, url?, published_at?, metadata?}`.
  - `metadata` keys become Milvus dynamic fields and come back in each hit's `metadata`.
  - The key `image` is reserved and rejected, because `NVIDIARerank` would send it to the reranker as an image.
  - Keys that repeat a schema column are rejected too.
- **Out:** `collection-manifest.json`:
  `{collection, physical_collection, source_ids, document_count, chunk_count, embed_model, index}`.

Each build is its own collection, `<alias>__<fingerprint>`. The fingerprint covers the corpus bytes, the embed
URL and model, the chunking and the index parameters.

- Re-running `ingest` on unchanged input does nothing.
- Changed input builds a new collection and moves the alias only when it is complete, so `serve` keeps answering
  from the previous build. Older builds are then dropped.

## Tool result

`retrieve_evidence(query, source_ids, top_k=8)` returns:

- `hits[]`: `rank`, `score` (rerank logit), `vector_score` (cosine), `source_id`, `document_id`, `chunk_id`,
  `title`, `url`, `published_at`, `snippet` and `metadata`.
- `candidate_counts`, per source.
- `collection`, the alias, and `collection_version`, the build it pointed at (`<alias>__<fingerprint>`). The alias
  is resolved once per call, so every source is searched in the same build, even during a reindex.
- `models`: `embed` and `rerank`.
- `index`: HNSW/COSINE, `M=16`, `efConstruction=200`, `ef=128`.
- `timings`: `embed_ms`, `search_ms`, `rerank_ms`, `total_ms`.
- Also `query` and `source_ids`.

### Size

A passage is a chunk of up to 2,400 characters. Each hit adds about 1 KB of ids, URL, citation, other metadata
and JSON indentation, so one copy of a result is at most about `top_k × 3.3 KB`.

The MCP SDK sends every result twice: once as `structuredContent` and once as the same JSON in a text block.
The response on the wire is therefore about double one copy. Hermes drops `structuredContent` when a text block
repeats it, so the model reads only one copy.

These are the worst-case sizes, measured in-process with every hit a full chunk and EDGAR-style metadata:

| `top_k` | one copy | JSON-RPC response |
|---|---|---|
| 3 | 11 KB | 21 KB |
| 8 (default) | 27 KB | 53 KB |
| 25 | 83 KB | 164 KB |

OpenShell 0.1.2 limits JSON-RPC bodies to 64 KiB by default, but only request bodies (the tool arguments), so
these responses pass through.

## LangChain configuration choices

Everything uses public API; there are no patches.

1. **`register_model` for `nemotron-3-embed-1b`.** Release 1.4.3 has no table entry for the model. Without
   one, construction runs a blocking `GET /v1/models` lookup.
2. **Explicit `base_url` and `api_key` on every client.** The package's defaults come from `NVIDIA_BASE_URL` and
   `NVIDIA_API_KEY`, which belong to other services in this stack.
3. **Rerank `max_batch_size=200`.** Search never collects more than 200 candidates, so reranking is always one
   request. A 200-passage request was verified live.
4. **Retries around every embed and rerank call.** The clients have none, and their timeout is fixed at 60 s.
   - These are retried: dropped connections, timeouts, 408, 429 and 5xx. That includes the async client's
     `[###] Unknown Error`, which is how it reports a non-JSON error body, such as a gateway's 502/503/504 page.
   - A tool call gets 3 attempts, because an agent is waiting on it.
   - `ingest` gets 8 attempts, with 0.5 s to 8 s of jittered backoff. One request that fails for good restarts
     the whole build.
5. **Three explicit spans.** LangChain's instrumentation emits nothing for direct embed, search or rerank calls.
6. **Pin `==1.4.3` and set `NVIDIA_USAGE_TELEMETRY_ENABLED=false`.** The next release turns on usage telemetry
   by default, and 1.4.3 is the floor for GHSA-g28h-2cmm-rj9x.
7. **The metadata key `image` is reserved.**

The store is plain `pymilvus` 2.6, matching the Milvus 2.6 server, with an explicit schema:

- `chunk_id` primary key and `source_id` partition key;
- `document_id`, `title`, `url`, `published_at` and `text` columns;
- an `embedding` `FLOAT_VECTOR` column;
- dynamic fields for each source's extra metadata.

`milvus/embedEtcd.yaml` and `milvus/user.yaml` configure the single-container Milvus: embedded etcd, local
storage, no MinIO. They come from the official `standalone_embed.sh` recipe.

## Run

`scripts/demo.sh` runs both commands as part of the stack. By hand, from the repository root:

```bash
docker compose --profile retrieval run --rm retrieval-index   # build or refresh the index
docker compose --profile retrieval up -d retrieval            # serve at 127.0.0.1:8120/mcp
```

The image runs as uid 1000. `ingest` writes the manifest into `/data/active`, so `retrieval-index` mounts the
`demo-data` volume read-write; `retrieval` mounts it read-only.

Locally, with Milvus Lite:

```bash
cd tools/retrieval && uv sync
MILVUS_URI=./milvus.db RETRIEVER_API_KEY=nvapi-... uv run demo-retrieval ingest --data-dir ../../path/to/active
```

## Test

```bash
uv run pytest                                  # offline: Milvus Lite + a fake NVIDIA transport
RETRIEVER_API_KEY=nvapi-... uv run pytest -m live   # 20 documents against build.nvidia.com; never in CI
```
