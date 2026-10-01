# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""retrieval-benchmark: the GPU copy of the build, the timed profiles, the quality gates and the claim.

Milvus Lite stands in for both servers here, with a FLAT index for the GPU copy; the box runs GPU_IVF_FLAT.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
from pymilvus import MilvusClient

from demo_retrieval import benchmark
from demo_retrieval import store
from demo_retrieval.datapack import BenchmarkQuery
from demo_retrieval.datapack import CollectionManifest
from demo_retrieval.settings import Settings

FLAT = {"index_type": "FLAT", "metric_type": "IP", "params": {}}
FLAT_SEARCH = {"metric_type": "IP", "params": {}}
QUERIES = [
    {"query": "cybersecurity incident disclosure", "sources": ["market_news"]},
    {"query": "merger agreement", "sources": ["market_news"]},
    {"query": "share buyback", "sources": ["market_regulations"]},
    {"query": "dividend increase", "sources": ["market_news", "market_regulations"]},
]


@pytest.fixture
def gpu_settings(settings: Settings, tmp_path: Path) -> Settings:
    return replace(settings, milvus_gpu_uri=str(tmp_path / "milvus-gpu.db"))


@pytest.fixture
def with_queries(data_dir: Path, manifest: CollectionManifest) -> Path:
    pack = json.loads((data_dir / "pack.json").read_text())
    pack["documents"]["benchmark_queries"] = QUERIES
    (data_dir / "pack.json").write_text(json.dumps(pack))
    return data_dir


def test_the_comparison_mirrors_the_build_and_measures_every_profile(gpu_settings, with_queries, manifest):
    result = benchmark.run(gpu_settings, with_queries, gpu_index=FLAT, gpu_search_params=FLAT_SEARCH)

    assert result == json.loads((with_queries / "retrieval-benchmark.json").read_text())
    assert (result["collection"], result["collectionVersion"]) == (manifest.collection, manifest.physical_collection)
    assert (result["queryCount"], result["sourceIds"]) == (4, ["market_news", "market_regulations"])
    assert [p["profileId"] for p in result["profiles"]] == ["vector-single", "vector-batch", "vector-concurrency"]
    single, batch, concurrent = result["profiles"]
    assert (single["cpu"]["indexType"], single["gpu"]["indexType"]) == ("HNSW", "FLAT")
    # 4 queries x 3 repetitions; a batch holds one scope's queries, so 3 requests per repetition
    assert (single["cpu"]["requestCount"], single["cpu"]["vectorCount"]) == (12, 12)
    assert (batch["gpu"]["requestCount"], batch["gpu"]["vectorCount"]) == (9, 12)
    assert (concurrent["batchSize"], concurrent["concurrency"]) == (1, 5)
    for profile in result["profiles"]:
        assert profile["cpu"]["status"] == profile["gpu"]["status"] == "completed"
        assert profile["quality"] == {
            "passed": True,
            "cpuRecallAtK": 1.0,
            "gpuRecallAtK": 1.0,
            "cpuGpuOverlapAtK": 1.0,
            "failureReasons": [],
        }
        assert profile["claim"]["observedCpuOverGpuRatio"] > 0

    # The GPU Milvus holds one copy: this build's normalized vectors
    gpu = MilvusClient(uri=gpu_settings.milvus_gpu_uri)
    assert gpu.list_collections() == [manifest.physical_collection]
    assert gpu.get_collection_stats(manifest.physical_collection)["row_count"] == manifest.chunk_count
    gpu.close()


def test_an_unchanged_build_is_not_measured_again(gpu_settings, with_queries, nvidia_api):
    first = benchmark.run(gpu_settings, with_queries, gpu_index=FLAT, gpu_search_params=FLAT_SEARCH)
    nvidia_api.calls.clear()

    assert benchmark.run(gpu_settings, with_queries, gpu_index=FLAT, gpu_search_params=FLAT_SEARCH) == first
    assert nvidia_api.calls == []


def test_a_copy_under_another_index_is_rebuilt_and_measured_again(gpu_settings, with_queries, manifest, nvidia_api):
    """After a change of the GPU index, an unchanged build's copy and its result are stale."""
    benchmark.run(gpu_settings, with_queries, gpu_index=FLAT, gpu_search_params=FLAT_SEARCH)
    nvidia_api.calls.clear()
    other = {"index_type": "IVF_FLAT", "metric_type": "IP", "params": {"nlist": 4}}

    result = benchmark.run(gpu_settings, with_queries, gpu_index=other, gpu_search_params=FLAT_SEARCH)

    assert nvidia_api.calls  # measured again: the queries were embedded
    assert {profile["gpu"]["indexType"] for profile in result["profiles"]} == {"IVF_FLAT"}
    gpu = MilvusClient(uri=gpu_settings.milvus_gpu_uri)
    [index] = gpu.list_indexes(manifest.physical_collection, field_name=store.VECTOR_FIELD)
    assert gpu.describe_index(manifest.physical_collection, index_name=index)["index_type"] == "IVF_FLAT"
    gpu.close()


def test_nothing_is_compared_without_a_gpu_milvus_or_queries(settings, gpu_settings, data_dir, manifest):
    assert benchmark.run(settings, data_dir) is None  # a CPU-only stack
    assert benchmark.run(gpu_settings, data_dir) is None  # a pack without benchmark queries
    assert not (data_dir / "retrieval-benchmark.json").exists()


def test_exact_neighbors_are_scored_within_the_scope_and_ties_are_one_neighbor():
    vectors = benchmark.Vectors(
        ids=np.asarray(["a", "b", "c", "d"]),
        sources=np.asarray(["news", "news", "rules", "news"]),
        matrix=benchmark._normalized(np.asarray([[1, 0], [1, 1], [1, 0], [0, 1]], dtype=np.float32)),
    )
    query = np.asarray([1.0, 0.0])

    assert vectors.exact(query, ["news"], k=2) == [1.0, 0.707107]
    # "a" and "c" hold the same vector: either one is a correct nearest neighbor
    score = vectors.scorer(query)
    truth = vectors.exact(query, ["news", "rules"], k=2)
    assert benchmark._recall([score("c"), score("a")], truth) == 1.0
    assert benchmark._recall([score("a"), score("b")], truth) == 0.5


def test_batches_group_one_scope_and_concurrency_runs_waves():
    queries = [BenchmarkQuery(f"q{i}", ("news",) if i % 3 else ("rules",)) for i in range(7)]

    batches = benchmark.waves(queries, benchmark.Profile("b", "batch", batch_size=2))
    concurrent = benchmark.waves(queries, benchmark.Profile("c", "concurrency", concurrency=5))

    assert [[r.queries for r in wave] for wave in batches] == [[(0, 3)], [(6,)], [(1, 2)], [(4, 5)]]
    assert all(len({queries[q].source_ids for q in r.queries}) == 1 for wave in batches for r in wave)
    assert [len(wave) for wave in concurrent] == [5, 2]


def measured(*, ms: float, ids: list[list[str]], error: str | None = None) -> benchmark.Measurement:
    found = dict(enumerate(ids))
    return benchmark.Measurement(total_ms=ms, latencies_ms=[ms], requests=1, vectors=1, results=[found], error=error)


def test_quality_gates_need_recall_and_agreement():
    exact = [["a", "b"], ["c", "d"]]
    good = benchmark.quality({"cpu": measured(ms=10, ids=exact), "gpu": measured(ms=5, ids=exact)}, exact)
    poor = benchmark.quality(
        {"cpu": measured(ms=10, ids=exact), "gpu": measured(ms=5, ids=[["a", "x"], ["c", "d"]])}, exact
    )
    failed = benchmark.quality({"cpu": measured(ms=10, ids=exact), "gpu": measured(ms=0, ids=[], error="boom")}, exact)

    assert good["passed"] and good["cpuGpuOverlapAtK"] == 1.0
    assert not poor["passed"]
    assert poor["gpuRecallAtK"] == 0.75
    assert "gpu_recall_below_0.95" in poor["failureReasons"]
    assert "worst_query_recall_below_0.8" in poor["failureReasons"]
    assert "cpu_gpu_overlap_below_0.95" in poor["failureReasons"]
    assert failed == {
        "passed": False,
        "cpuRecallAtK": None,
        "gpuRecallAtK": None,
        "cpuGpuOverlapAtK": None,
        "failureReasons": ["gpu_search_failed"],
    }


@pytest.mark.parametrize(
    ("passed", "cpu_ms", "gpu_ms", "expected"),
    [
        (True, 22.0, 10.0, {"decision": "gpu_speedup", "observedCpuOverGpuRatio": 2.2, "gpuSpeedupFactor": 2.2}),
        (
            True,
            10.5,
            10.0,
            {"decision": "cpu_faster_or_equal", "observedCpuOverGpuRatio": 1.05, "gpuSpeedupFactor": None},
        ),
        (False, 22.0, 10.0, {"decision": "no_claim", "observedCpuOverGpuRatio": 2.2, "gpuSpeedupFactor": None}),
    ],
)
def test_a_speedup_is_claimed_only_past_the_threshold_with_passing_quality(passed, cpu_ms, gpu_ms, expected):
    index = benchmark.Index("cpu", None, "x", "HNSW", store.SEARCH_PARAMS)
    cpu = benchmark.backend(index, measured(ms=cpu_ms, ids=[]))
    gpu = benchmark.backend(replace(index, role="gpu"), measured(ms=gpu_ms, ids=[]))

    assert benchmark.claim(passed, cpu, gpu) == expected
