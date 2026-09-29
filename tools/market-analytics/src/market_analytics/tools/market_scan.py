# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""market_scan: rank a universe by return, volume, volatility or peer-relative return over a window."""

from __future__ import annotations

from datetime import datetime

from ..data import MarketData
from ..models import Comparison
from ..models import Direction
from ..models import InvalidRequest
from ..models import MarketScanPayload
from ..models import Metric
from ..models import RankedAsset
from .common import Output
from .common import check_window

LIMITATIONS = ("Results are descriptive historical observations and are not investment advice.",)

COLUMNS: dict[Metric, str] = {
    "return": "total_return",
    "volume": "total_volume",
    "volatility": "volatility",
    "peer_relative_return": "peer_relative_return",
}


def run(
    data: MarketData,
    *,
    universe_id: str,
    start: datetime,
    end: datetime,
    metrics: list[Metric],
    comparison: Comparison = "absolute",
    direction: Direction = "highest",
    limit: int = 10,
) -> Output:
    check_window(start, end)
    if len(set(metrics)) != len(metrics):
        raise InvalidRequest("metrics must be unique")
    prices = data.prices
    bars = prices[prices["asset_id"].isin(data.universe(universe_id)) & prices["timestamp"].between(start, end)]
    if bars.empty:
        payload = MarketScanPayload(
            universe_id=universe_id,
            primary_metric=metrics[0],
            comparison=comparison,
            direction=direction,
            assets_ranked=0,
            observations=[],
        )
        return Output(payload, rows_scanned=0, empty=True, warnings=("No prices matched the universe and window.",))

    summary = bars.groupby("asset_id").agg(
        start_price=("adjusted_close", "first"),
        end_price=("adjusted_close", "last"),
        total_volume=("volume", "sum"),
        volatility=("adjusted_return_1d", "std"),
        observation_count=("adjusted_close", "count"),
    )
    summary["volatility"] = summary["volatility"].fillna(0.0)
    summary["total_return"] = summary["end_price"] / summary["start_price"] - 1
    summary["peer_relative_return"] = summary["total_return"] - summary["total_return"].mean()
    summary["coverage_ratio"] = summary["observation_count"] / summary["observation_count"].max()

    primary = summary[COLUMNS[metrics[0]]]
    if comparison == "magnitude":
        summary["score"] = primary.abs()
    elif comparison == "zscore":
        spread = primary.std(ddof=0)
        summary["score"] = (primary - primary.mean()) / spread if spread > 0 else 0.0
    else:
        summary["score"] = primary
    ranked = (
        summary.reset_index()
        .sort_values(["score", "asset_id"], ascending=[direction == "lowest", True])
        .head(limit)
        .to_dict("records")
    )
    observations = [
        RankedAsset(
            rank=rank,
            asset_id=row["asset_id"],
            score=row["score"],
            values={metric: row[COLUMNS[metric]] for metric in metrics},
            observation_count=row["observation_count"],
            coverage_ratio=row["coverage_ratio"],
        )
        for rank, row in enumerate(ranked, start=1)
    ]
    payload = MarketScanPayload(
        universe_id=universe_id,
        primary_metric=metrics[0],
        comparison=comparison,
        direction=direction,
        assets_ranked=len(summary),
        observations=observations,
    )
    return Output(payload, rows_scanned=len(bars))
