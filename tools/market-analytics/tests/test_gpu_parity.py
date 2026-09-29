# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""The GPU worker (cudf.pandas, cuml.accel, nx-cugraph) gives the same answers as pandas on the CPU.

Needs an NVIDIA GPU and `uv sync --extra gpu-cu12`; skipped otherwise. Loading the pack falls back to pandas twice
(merge_asof and rename_axis, which cudf.pandas does not implement), which is expected, so
CUDF_PANDAS_FAIL_ON_FALLBACK=1 makes every test here error at startup. The tool calls themselves run on the GPU.
"""

import importlib.util
import math
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fixture_pack import at

from market_analytics import tools
from market_analytics.data import MarketData
from market_analytics.worker import Worker

pytestmark = [
    pytest.mark.gpu,
    pytest.mark.skipif(
        importlib.util.find_spec("cudf") is None or shutil.which("nvidia-smi") is None,
        reason="needs an NVIDIA GPU and the gpu-cu12 extra",
    ),
]

JUNE = {"start": at(21, 0), "end": at(41, 23)}
CALLS = [
    ("market_scan", {"universe_id": "all_assets", "metrics": ["return", "volatility"], **JUNE}),
    ("market_scan", {"universe_id": "all_assets", "metrics": ["volume"], "comparison": "zscore", **JUNE}),
    (
        "market_anomaly_scan",
        {
            "universe_id": "all_assets",
            "training_start": at(20, 0),
            "training_end": at(49, 23),
            "scoring_start": at(50, 0),
            "scoring_end": at(69, 23),
        },
    ),
    ("price_context", {"asset_ids": ["ALPH", "GAMA"], "frequency": "weekly", **JUNE}),
    ("sentiment_timeline", {"start": at(0, 0), "end": at(69, 23), "frequency": "weekly"}),
    ("analyze_news_price_relationship", {"published_from": at(0, 0), "published_to": at(69, 23)}),
    ("analyze_market_relationships", {"top_k": 4}),
]


@pytest.fixture(scope="module")
def gpu_worker(pack_root: Path) -> Iterator[Worker]:
    worker = Worker(pack_root, timeout=300)
    with pytest.MonkeyPatch.context() as env:
        env.setenv("MARKET_ANALYTICS_ENGINE", "gpu")  # the worker process inherits it at start
        worker.start()
    yield worker
    worker.close()


@pytest.mark.parametrize(("tool", "arguments"), CALLS)
def test_gpu_matches_cpu(data: MarketData, gpu_worker: Worker, tool: str, arguments: dict[str, Any]) -> None:
    cpu = tools.run(data, tool, arguments)
    gpu = gpu_worker.call(tool, arguments)

    assert gpu["engine"]["device"] == "gpu"
    assert gpu["engine"]["library"] in {"cudf.pandas", "cuml.accel", "nx-cugraph"}
    assert gpu["status"] == cpu["status"] == "succeeded"
    assert_close(gpu["payload"], cpu["payload"])


def assert_close(gpu: Any, cpu: Any, path: str = "payload") -> None:
    """Equal structure, ids, ranks and timestamps; floats within GPU rounding."""
    if isinstance(cpu, dict):
        assert gpu.keys() == cpu.keys(), path
        for key in cpu:
            assert_close(gpu[key], cpu[key], f"{path}.{key}")
    elif isinstance(cpu, list):
        assert len(gpu) == len(cpu), path
        for index, (gpu_item, cpu_item) in enumerate(zip(gpu, cpu, strict=True)):
            assert_close(gpu_item, cpu_item, f"{path}[{index}]")
    elif isinstance(cpu, float):
        assert math.isclose(gpu, cpu, rel_tol=1e-4, abs_tol=1e-6), f"{path}: {gpu} != {cpu}"
    else:
        assert gpu == cpu, path
