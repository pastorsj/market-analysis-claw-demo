# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""retrieval-benchmark: the CPU index against an NVIDIA GPU (cuVS) index of the same vectors (analytics-gpu profile).

The one-shot reads the active build's vectors from Milvus and mirrors them, L2-normalized, into the GPU Milvus
(MILVUS_GPU_URI) under a GPU_CAGRA index. It embeds the pack's held-out queries once (documents.benchmark_queries) and
times their vector searches on both indexes in three workload profiles: one query per request, batches of five query
vectors, and five concurrent requests. Each profile warms both indexes up, then repeats its requests three times,
alternating which index goes first. Only the Milvus search call is timed; nothing is reranked.

Each profile reports recall@10 against the exact inner-product neighbors (computed here from the same vectors) and the
overlap of the two indexes' results. Both compare neighbors by their exact score, so chunks with identical vectors
(boilerplate repeated across filings) count as the same neighbor whichever of them an index returns. A profile claims
a GPU speedup only when those quality gates pass and the CPU's total search time is at least 1.1 times the GPU's. The
result goes to retrieval-benchmark.json beside collection-manifest.json, where the API reads it for runs on the same
build (demo_api.benchmark.RetrievalBenchmark).

Answers never come from the GPU mirror: retrieve_evidence searches the CPU index on every host. On an unchanged build
the one-shot is a no-op. It never fails the stack: a problem is logged, and the Benchmark tab says no comparison
applies.
"""

from __future__ import annotations

import json
import logging
import time
from collections import Counter
from collections.abc import Callable
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from dataclasses import field
from datetime import UTC
from datetime import datetime
from pathlib import Path
from statistics import fmean
from typing import Any
from typing import Literal

import numpy as np
from langchain_nvidia_ai_endpoints import NVIDIAEmbeddings
from pymilvus import DataType
from pymilvus import MilvusClient

from . import nvidia
from . import store
from .datapack import BENCHMARK
from .datapack import MANIFEST
from .datapack import BenchmarkQuery
from .datapack import CollectionManifest
from .datapack import Pack
from .settings import Settings

TOP_K = 10
REPETITIONS = 3
WARMUP_ROUNDS = 1
MIN_RECALL = 0.95  # mean recall@k of each index
MIN_WORST_QUERY_RECALL = 0.80
MIN_OVERLAP = 0.95  # mean Jaccard overlap of the two indexes' top-k
MIN_GPU_SPEEDUP = 1.10
COPY_BATCH = 500  # rows per read and insert: 2048-dimension vectors keep a batch near 4 MB
INDEX_TIMEOUT_SECONDS = 900.0

logger = logging.getLogger(__name__)

Role = Literal["cpu", "gpu"]


@dataclass(frozen=True)
class Profile:
    profile_id: str
    mode: Literal["single", "batch", "concurrency"]
    batch_size: int = 1
    concurrency: int = 1


PROFILES = (
    Profile("vector-single", "single"),
    Profile("vector-batch", "batch", batch_size=5),
    Profile("vector-concurrency", "concurrency", concurrency=5),
)


@dataclass(frozen=True)
class Index:
    """One side of the comparison: a Milvus, the build's collection in it, and how to search it."""

    role: Role
    client: MilvusClient
    collection: str
    index_type: str
    search_params: dict[str, Any]


@dataclass(frozen=True)
class Vectors:
    """The build's rows: chunk ids, sources and vectors."""

    ids: np.ndarray
    sources: np.ndarray
    matrix: np.ndarray  # float32, each row L2-normalized

    def exact(self, vector: np.ndarray, scope: Sequence[str], k: int = TOP_K) -> list[float]:
        """The scores of the k nearest chunks of the scope's sources (inner product), best first."""
        scores = self.matrix[np.isin(self.sources, list(scope))] @ vector
        return [_rounded(score) for score in np.sort(scores)[::-1][:k]]

    def scorer(self, vector: np.ndarray) -> Callable[[str], float]:
        """A chunk's exact score for this query vector."""
        rows = {str(chunk_id): row for row, chunk_id in enumerate(self.ids)}
        return lambda chunk_id: _rounded(self.matrix[rows[chunk_id]] @ vector)


def _rounded(score: float) -> float:
    return round(float(score), 6)


@dataclass(frozen=True)
class Request:
    queries: tuple[int, ...]  # positions in the query list: one vector each
    scope: tuple[str, ...]


@dataclass
class Measurement:
    """One index's timed requests in one profile."""

    total_ms: float = 0.0
    latencies_ms: list[float] = field(default_factory=list)
    requests: int = 0
    vectors: int = 0
    results: list[dict[int, list[Any]]] = field(default_factory=list)  # each repetition's neighbors, by query
    error: str | None = None


def run(
    settings: Settings,
    data_dir: Path,
    *,
    gpu_index: dict[str, Any] = store.GPU_INDEX,
    gpu_search_params: dict[str, Any] = store.GPU_SEARCH_PARAMS,
) -> dict[str, Any] | None:
    """Measure the active build and write retrieval-benchmark.json; None when there is nothing to compare."""
    if not settings.milvus_gpu_uri:
        logger.info("MILVUS_GPU_URI is not set: this stack has no GPU index to compare")
        return None
    if not (data_dir / MANIFEST).is_file():
        logger.info("the active build has no retrieval index: nothing to compare")
        return None
    manifest = CollectionManifest.load(data_dir)
    indexed = set(manifest.source_ids)
    queries = [query for query in Pack.load(data_dir).benchmark_queries if set(query.source_ids) <= indexed]
    if not queries:
        logger.warning("the pack has no documents.benchmark_queries for %s: nothing to compare", sorted(indexed))
        return None

    collection = manifest.physical_collection
    cpu = MilvusClient(uri=settings.milvus_uri)
    gpu = MilvusClient(uri=settings.milvus_gpu_uri)
    try:
        previous = _previous(data_dir, collection)
        if previous is not None and gpu.has_collection(collection):
            logger.info("%s was already measured: %s", collection, data_dir / BENCHMARK)
            return previous
        vectors = read_vectors(cpu, collection)
        _wait_indexed(cpu, collection, len(vectors.ids))  # time the index, not a growing segment's brute force
        mirror(gpu, manifest.collection, collection, vectors, gpu_index)
        query_vectors = embed_queries(nvidia.embedder(settings), queries)
        exact = [vectors.exact(vector, query.source_ids) for vector, query in zip(query_vectors, queries, strict=True)]
        scorers = [vectors.scorer(vector) for vector in query_vectors]
        indexes = {
            "cpu": Index("cpu", cpu, collection, manifest.index["index_type"], store.SEARCH_PARAMS),
            "gpu": Index("gpu", gpu, collection, gpu_index["index_type"], gpu_search_params),
        }
        profiles = [
            profile_result(profile, indexes, queries, query_vectors, exact=exact, scorers=scorers)
            for profile in PROFILES
        ]
    finally:
        cpu.close()
        gpu.close()

    result = {
        "schemaVersion": "1",
        "collection": manifest.collection,
        "collectionVersion": collection,
        "embedModel": manifest.embed_model,
        "sourceIds": sorted({source for query in queries for source in query.source_ids}),
        "queryCount": len(queries),
        "measuredAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "profiles": profiles,
    }
    staged = data_dir / f"{BENCHMARK}.tmp"  # write then rename, so the API never reads half a file
    staged.write_text(json.dumps(result, indent=2) + "\n")
    staged.replace(data_dir / BENCHMARK)
    for profile in profiles:
        logger.info(
            "%s: CPU %.1f ms, GPU %.1f ms, %s",
            profile["profileId"],
            profile["cpu"]["vectorSearchMs"],
            profile["gpu"]["vectorSearchMs"],
            profile["claim"]["decision"],
        )
    return result


def _previous(data_dir: Path, collection: str) -> dict[str, Any] | None:
    try:
        previous = json.loads((data_dir / BENCHMARK).read_text())
    except (OSError, ValueError):
        return None
    return previous if previous.get("collectionVersion") == collection else None


def read_vectors(client: MilvusClient, collection: str) -> Vectors:
    """Every row's chunk id, source and vector, L2-normalized."""
    ids: list[str] = []
    sources: list[str] = []
    rows: list[list[float]] = []
    client.load_collection(collection)
    iterator = client.query_iterator(
        collection, batch_size=COPY_BATCH, output_fields=["chunk_id", "source_id", store.VECTOR_FIELD]
    )
    try:
        while batch := iterator.next():
            for row in batch:
                ids.append(row["chunk_id"])
                sources.append(row["source_id"])
                rows.append(row[store.VECTOR_FIELD])
    finally:
        iterator.close()
    if not rows:
        raise ValueError(f"{collection} holds no vectors")
    return Vectors(np.asarray(ids), np.asarray(sources), _normalized(np.asarray(rows, dtype=np.float32)))


def mirror(client: MilvusClient, alias: str, collection: str, vectors: Vectors, index: dict[str, Any]) -> None:
    """The build's GPU copy: its chunk ids, sources and normalized vectors under `index`. Reused once complete.

    Older builds' copies are dropped, so the GPU holds one.
    """
    rows = len(vectors.ids)
    if client.has_collection(collection) and _row_count(client, collection) == rows:
        logger.info("reusing the GPU copy of %s", collection)
    else:
        if client.has_collection(collection):
            client.drop_collection(collection)
        schema = client.create_schema(auto_id=False, enable_dynamic_field=False)
        schema.add_field("chunk_id", DataType.VARCHAR, max_length=512, is_primary=True)
        schema.add_field("source_id", DataType.VARCHAR, max_length=128, is_partition_key=True)
        schema.add_field(store.VECTOR_FIELD, DataType.FLOAT_VECTOR, dim=vectors.matrix.shape[1])
        client.create_collection(collection, schema=schema, consistency_level="Strong")
        for start in range(0, rows, COPY_BATCH):
            stop = start + COPY_BATCH
            batch = zip(vectors.ids[start:stop], vectors.sources[start:stop], vectors.matrix[start:stop], strict=True)
            client.insert(
                collection,
                [{"chunk_id": str(i), "source_id": str(s), store.VECTOR_FIELD: v.tolist()} for i, s, v in batch],
            )
        client.flush(collection)  # seal the segments, so the index covers every row
        params = client.prepare_index_params()
        params.add_index(store.VECTOR_FIELD, **index)
        client.create_index(collection, params)
        logger.info("copied %d vectors of %s to the GPU Milvus under %s", rows, collection, index["index_type"])
    _wait_indexed(client, collection, rows)
    client.load_collection(collection)
    for name in client.list_collections():
        if name.startswith(store.build_name(alias, "")) and name != collection:
            client.drop_collection(name)


def _row_count(client: MilvusClient, collection: str) -> int:
    return int(client.get_collection_stats(collection).get("row_count", 0))


def _wait_indexed(client: MilvusClient, collection: str, rows: int) -> None:
    """Flush, then wait until the vector index covers every row (Milvus builds it in the background)."""
    client.flush(collection)
    deadline = time.monotonic() + INDEX_TIMEOUT_SECONDS
    while True:
        described = client.describe_index(collection, index_name=store.VECTOR_FIELD)
        indexed = described.get("indexed_rows")
        if indexed is None or (int(indexed) >= rows and not int(described.get("pending_index_rows", 0))):
            return
        if time.monotonic() > deadline:
            raise TimeoutError(f"{collection}: {indexed} of {rows} rows indexed after {INDEX_TIMEOUT_SECONDS:.0f} s")
        time.sleep(2)


def embed_queries(embedder: NVIDIAEmbeddings, queries: Sequence[BenchmarkQuery]) -> list[np.ndarray]:
    """Each query embedded once (input_type=query) and L2-normalized; outside every timed search."""
    return list(_normalized(np.asarray([_embed_query(embedder, query.query) for query in queries], dtype=np.float32)))


@nvidia.retry_bulk
def _embed_query(embedder: NVIDIAEmbeddings, text: str) -> list[float]:
    return embedder.embed_query(text)


def _normalized(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.where(norms == 0, 1, norms)


def waves(queries: Sequence[BenchmarkQuery], profile: Profile) -> list[list[Request]]:
    """The profile's requests in waves: one request at a time, or `concurrency` requests at once.

    A batch holds queries of one source scope, since one request has one filter.
    """
    if profile.mode == "batch":
        by_scope: dict[tuple[str, ...], list[int]] = {}
        for position, query in enumerate(queries):
            by_scope.setdefault(query.source_ids, []).append(position)
        return [
            [Request(tuple(positions[start : start + profile.batch_size]), scope)]
            for scope, positions in by_scope.items()
            for start in range(0, len(positions), profile.batch_size)
        ]
    requests = [Request((position,), query.source_ids) for position, query in enumerate(queries)]
    if profile.mode == "single":
        return [[request] for request in requests]
    return [requests[start : start + profile.concurrency] for start in range(0, len(requests), profile.concurrency)]


def search(index: Index, vectors: list[np.ndarray], scope: Sequence[str]) -> tuple[float, list[list[str]]]:
    """One search request, timed around the Milvus call only: (milliseconds, the top-k ids per vector)."""
    data = [vector.tolist() for vector in vectors]
    started = time.perf_counter()
    results = index.client.search(
        index.collection,
        data=data,
        anns_field=store.VECTOR_FIELD,
        filter=f"source_id in {json.dumps(list(scope))}",
        limit=TOP_K,
        search_params=index.search_params,
        output_fields=["chunk_id"],
    )
    elapsed = (time.perf_counter() - started) * 1000
    return elapsed, [[str(hit["entity"]["chunk_id"]) for hit in hits] for hits in results]


def _wave(
    index: Index, wave: list[Request], vectors: list[np.ndarray], pool: ThreadPoolExecutor
) -> tuple[float, list[float], dict[int, list[str]]]:
    """(the wave's wall time, each request's time, the ids each query found)."""
    started = time.perf_counter()
    futures = [pool.submit(search, index, [vectors[q] for q in request.queries], request.scope) for request in wave]
    outcomes = [future.result() for future in futures]
    wall = (time.perf_counter() - started) * 1000 if len(wave) > 1 else outcomes[0][0]
    found: dict[int, list[str]] = {}
    for request, (_, ids) in zip(wave, outcomes, strict=True):
        found.update(zip(request.queries, ids, strict=True))
    return wall, [elapsed for elapsed, _ in outcomes], found


def measure(
    profile: Profile, indexes: dict[str, Index], queries: Sequence[BenchmarkQuery], vectors: list[np.ndarray]
) -> dict[str, Measurement]:
    """Warm both indexes up on the first wave, then time every wave REPETITIONS times, alternating which goes first."""
    plan = waves(queries, profile)
    measurements = {role: Measurement() for role in ("cpu", "gpu")}
    with ThreadPoolExecutor(max_workers=profile.concurrency) as pool:
        for repetition in range(-WARMUP_ROUNDS, REPETITIONS):
            for role in ("cpu", "gpu") if repetition % 2 == 0 else ("gpu", "cpu"):
                measured = measurements[role]
                if measured.error:
                    continue
                found: dict[int, list[str]] = {}
                try:
                    for wave in plan[:1] if repetition < 0 else plan:
                        wall, latencies, ids = _wave(indexes[role], wave, vectors, pool)
                        if repetition >= 0:
                            measured.total_ms += wall
                            measured.latencies_ms += latencies
                            measured.requests += len(wave)
                            measured.vectors += sum(len(request.queries) for request in wave)
                        found.update(ids)
                except Exception as error:  # a failed request fails this index for the profile
                    measured.error = f"{type(error).__name__}: {error}"[:300]
                    logger.warning("%s %s search failed: %s", profile.profile_id, role, measured.error)
                    continue
                if repetition >= 0:
                    measured.results.append(found)
    return measurements


def profile_result(
    profile: Profile,
    indexes: dict[str, Index],
    queries: Sequence[BenchmarkQuery],
    vectors: list[np.ndarray],
    *,
    exact: list[list[float]],
    scorers: list[Callable[[str], float]],
) -> dict[str, Any]:
    measured = measure(profile, indexes, queries, vectors)
    backends = {role: backend(indexes[role], measured[role]) for role in ("cpu", "gpu")}
    for measurement in measured.values():  # neighbors as their exact scores, so equal vectors are one neighbor
        measurement.results = [
            {position: [scorers[position](chunk) for chunk in chunks] for position, chunks in found.items()}
            for found in measurement.results
        ]
    gates = quality(measured, exact)
    return {
        "profileId": profile.profile_id,
        "executionMode": profile.mode,
        "batchSize": profile.batch_size,
        "concurrency": profile.concurrency,
        "repetitions": REPETITIONS,
        "topK": TOP_K,
        **backends,
        "quality": gates,
        "claim": claim(gates["passed"], backends["cpu"], backends["gpu"]),
    }


def backend(index: Index, measured: Measurement) -> dict[str, Any]:
    completed = measured.error is None and measured.requests > 0
    latencies = measured.latencies_ms or [0.0]
    return {
        "role": index.role,
        "indexType": index.index_type,
        "status": "completed" if completed else "failed",
        "requestCount": measured.requests,
        "vectorCount": measured.vectors,
        "p50Ms": round(float(np.percentile(latencies, 50)), 3),
        "p95Ms": round(float(np.percentile(latencies, 95)), 3),
        "vectorSearchMs": round(measured.total_ms, 3),
        "vectorQps": round(measured.vectors / (measured.total_ms / 1000), 2) if measured.total_ms else 0.0,
    }


def quality(measured: dict[str, Measurement], exact: list[list[Any]]) -> dict[str, Any]:
    """Recall@k of each index against the exact neighbors, and the two indexes' overlap, on the last repetition.

    Neighbors compare as multisets of whatever identifies them (the run passes exact scores).
    """
    reasons = [f"{role}_search_failed" for role in ("cpu", "gpu") if measured[role].error or not measured[role].results]
    if reasons:
        return {
            "passed": False,
            "cpuRecallAtK": None,
            "gpuRecallAtK": None,
            "cpuGpuOverlapAtK": None,
            "failureReasons": reasons,
        }
    found = {role: measured[role].results[-1] for role in ("cpu", "gpu")}
    recalls = {
        role: [_recall(found[role].get(position, []), truth) for position, truth in enumerate(exact)]
        for role in ("cpu", "gpu")
    }
    overlap = fmean(_jaccard(found["cpu"].get(p, []), found["gpu"].get(p, [])) for p in range(len(exact)))
    means = {role: fmean(values) for role, values in recalls.items()}
    for role in ("cpu", "gpu"):
        if means[role] < MIN_RECALL:
            reasons.append(f"{role}_recall_below_{MIN_RECALL}")
        if any(results != measured[role].results[0] for results in measured[role].results):
            reasons.append(f"{role}_results_not_stable_across_repetitions")
    if min(min(values) for values in recalls.values()) < MIN_WORST_QUERY_RECALL:
        reasons.append(f"worst_query_recall_below_{MIN_WORST_QUERY_RECALL}")
    if overlap < MIN_OVERLAP:
        reasons.append(f"cpu_gpu_overlap_below_{MIN_OVERLAP}")
    return {
        "passed": not reasons,
        "cpuRecallAtK": round(means["cpu"], 4),
        "gpuRecallAtK": round(means["gpu"], 4),
        "cpuGpuOverlapAtK": round(overlap, 4),
        "failureReasons": reasons,
    }


def _recall(found: list[Any], truth: list[Any]) -> float:
    return (Counter(found) & Counter(truth)).total() / len(truth) if truth else 1.0


def _jaccard(left: list[Any], right: list[Any]) -> float:
    union = (Counter(left) | Counter(right)).total()
    return (Counter(left) & Counter(right)).total() / union if union else 1.0


def claim(passed: bool, cpu: dict[str, Any], gpu: dict[str, Any]) -> dict[str, Any]:
    """A GPU speedup only with passing quality and a CPU/GPU total search time of at least MIN_GPU_SPEEDUP."""
    measured = cpu["status"] == gpu["status"] == "completed" and cpu["vectorSearchMs"] and gpu["vectorSearchMs"]
    if not measured:
        return {"decision": "no_claim", "observedCpuOverGpuRatio": None, "gpuSpeedupFactor": None}
    ratio = round(cpu["vectorSearchMs"] / gpu["vectorSearchMs"], 4)
    if passed and ratio >= MIN_GPU_SPEEDUP:
        return {"decision": "gpu_speedup", "observedCpuOverGpuRatio": ratio, "gpuSpeedupFactor": ratio}
    decision = "cpu_faster_or_equal" if passed else "no_claim"
    return {"decision": decision, "observedCpuOverGpuRatio": ratio, "gpuSpeedupFactor": None}
