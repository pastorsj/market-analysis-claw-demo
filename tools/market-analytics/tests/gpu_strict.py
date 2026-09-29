# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Runs in a spawned process for test_gpu_parity.py. It imports nothing at module level, so the process can
install the GPU accelerators before pandas is imported (see bootstrap.py)."""

import os
from pathlib import Path
from typing import Any


def run_without_fallbacks(root: Path, calls: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    """Load the pack on the GPU, then run each call with CUDF_PANDAS_FAIL_ON_FALLBACK=1.

    Loading the pack falls back to pandas twice (merge_asof and rename_axis), which is allowed. cudf.pandas reads
    the variable at each fallback, so from then on a fallback raises and the call fails.
    """
    from market_analytics import bootstrap

    os.environ["MARKET_ANALYTICS_ENGINE"] = "gpu"
    bootstrap.install_gpu_accelerators()

    from market_analytics import tools
    from market_analytics.data import MarketData
    from market_analytics.data import Pack

    data = MarketData.load(Pack.load(root))
    os.environ["CUDF_PANDAS_FAIL_ON_FALLBACK"] = "1"
    return [tools.run(data, tool, arguments) for tool, arguments in calls]
