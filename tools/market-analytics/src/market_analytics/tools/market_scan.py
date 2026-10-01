# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""market_scan: rank a universe by return, volume, volatility or peer-relative return over a window."""

from __future__ import annotations

import json
from datetime import UTC
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


def both_windows(universe_id: str, end: datetime, sessions: int, metrics: list[Metric]) -> str:
    """The rejection of a call with both start and sessions, written so the model can fix the call in one retry:
    which argument to drop, and the call to make instead, built from its own arguments."""
    retry = json.dumps(
        {
            "universe_id": universe_id,
            "end": (end if end.tzinfo else end.replace(tzinfo=UTC)).astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "sessions": sessions,
            "metrics": metrics,
        }
    )
    return (
        "start and sessions cannot both be given: sessions already sets the window's start, counting back from end. "
        f"Call market_scan again without start, for the {sessions} sessions ending at end: {retry} "
        "(keep your other arguments). For a date range instead, drop sessions and keep start and end."
    )


def run(
    data: MarketData,
    *,
    universe_id: str,
    end: datetime,
    metrics: list[Metric],
    start: datetime | None = None,
    sessions: int | None = None,
    comparison: Comparison = "absolute",
    direction: Direction = "highest",
    limit: int = 10,
) -> Output:
    if len(set(metrics)) != len(metrics):
        raise InvalidRequest("metrics must be unique")
    prices = data.prices
    prices = prices[prices["asset_id"].isin(data.universe(universe_id))]
    if sessions is not None and start is not None:
        raise InvalidRequest(both_windows(universe_id, end, sessions, metrics))
    if sessions is not None:
        # "The N sessions ending D": the N latest sessions on or before D. Selecting them by value keeps a
        # timestamp read from the frame out of scalar comparisons, which cudf.pandas runs on the CPU.
        latest = prices.loc[prices["timestamp"] <= end, "timestamp"].drop_duplicates().nlargest(sessions)
        bars = prices[prices["timestamp"].isin(latest)]
    elif start is None:
        raise InvalidRequest("give start, or sessions for the sessions ending at end")
    else:
        check_window(start, end)
        bars = prices[prices["timestamp"].between(start, end)]
    if bars.empty:
        payload = MarketScanPayload(
            universe_id=universe_id,
            primary_metric=metrics[0],
            comparison=comparison,
            direction=direction,
            assets_ranked=0,
            observations=[],
        )
        return Output(
            payload, rows_scanned=0, assets=0, empty=True, warnings=("No prices matched the universe and window.",)
        )

    # A return runs from the close before the window's first session (data.py's return_base) to its last close.
    summary = bars.groupby("asset_id").agg(
        start_price=("return_base", "first"),
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
    return Output(payload, rows_scanned=len(bars), assets=len(summary))
