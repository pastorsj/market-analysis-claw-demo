# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""The six tools, called through the same dispatcher the worker uses."""

import math
from datetime import UTC
from datetime import datetime
from typing import Any

import pytest
from fixture_pack import GAMMA_SPIKE
from fixture_pack import at

from market_analytics import tools
from market_analytics.data import MarketData
from market_analytics.tools import market_scan

JUNE = {"start": datetime(2026, 6, 1, tzinfo=UTC), "end": datetime(2026, 6, 30, 23, 59, 59, tzinfo=UTC)}


def run(data: MarketData, tool: str, **arguments: Any) -> dict[str, Any]:
    return tools.run(data, tool, arguments)


def june_return(data: MarketData, asset_id: str) -> float:
    start, end = (JUNE[key].replace(tzinfo=None) for key in ("start", "end"))  # the frames hold naive UTC
    bars = data.prices[(data.prices["asset_id"] == asset_id) & data.prices["timestamp"].between(start, end)]
    return bars["adjusted_close"].iloc[-1] / bars["adjusted_close"].iloc[0] - 1


def test_market_scan_ranks_both_ends_of_a_universe(data: MarketData) -> None:
    returns = {asset: june_return(data, asset) for asset in data.universe("reviewed_assets")}
    leaders = run(data, "market_scan", universe_id="reviewed_assets", metrics=["return", "volume"], limit=2, **JUNE)
    laggard = run(data, "market_scan", universe_id="reviewed_assets", metrics=["return"], direction="lowest", **JUNE)

    assert leaders["status"] == "succeeded"
    assert leaders["engine"] == {"device": "cpu", "library": "pandas", "version": leaders["engine"]["version"]}
    assert leaders["rows_scanned"] == 3 * 22  # three assets, 22 June sessions
    payload = leaders["payload"]
    assert payload["assets_ranked"] == 3
    assert [row["asset_id"] for row in payload["observations"]] == sorted(returns, key=returns.get, reverse=True)[:2]
    assert payload["observations"][0]["values"]["return"] == pytest.approx(max(returns.values()))
    assert set(payload["observations"][0]["values"]) == {"return", "volume"}
    assert laggard["payload"]["observations"][0]["asset_id"] == min(returns, key=returns.get)


def test_market_scan_zscore_centers_the_scores(data: MarketData) -> None:
    result = run(data, "market_scan", universe_id="all_assets", metrics=["volatility"], comparison="zscore", **JUNE)
    scores = [row["score"] for row in result["payload"]["observations"]]
    assert scores == sorted(scores, reverse=True)
    assert sum(scores) == pytest.approx(0, abs=1e-9)


def test_market_scan_reports_an_empty_window_and_invalid_arguments(data: MarketData) -> None:
    empty = run(
        data,
        "market_scan",
        universe_id="all_assets",
        metrics=["return"],
        start=datetime(2020, 1, 1, tzinfo=UTC),
        end=datetime(2020, 2, 1, tzinfo=UTC),
    )
    assert empty["status"] == "empty"
    assert empty["payload"]["observations"] == []

    duplicate = run(data, "market_scan", universe_id="all_assets", metrics=["return", "return"], **JUNE)
    backwards = run(
        data, "market_scan", universe_id="all_assets", metrics=["return"], start=JUNE["end"], end=JUNE["start"]
    )
    for result in (duplicate, backwards):
        assert result["status"] == "failed"
        assert result["error"]["code"] == "invalid_request"
        assert result["payload"] is None


def test_unexpected_errors_become_execution_failures(data: MarketData, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_: Any, **__: Any) -> None:
        raise ZeroDivisionError

    monkeypatch.setitem(tools.TOOLS, "market_scan", tools.Tool(broken, "tabular", market_scan.LIMITATIONS))
    result = run(data, "market_scan", universe_id="all_assets", metrics=["return"], **JUNE)
    assert result["status"] == "failed"
    assert result["error"] == {
        "code": "execution_failed",
        "message": "market_scan could not complete; see the server log.",
    }


def test_anomaly_scan_ranks_the_planted_crash_first(data: MarketData) -> None:
    result = run(
        data,
        "market_anomaly_scan",
        universe_id="reviewed_assets",
        training_start=at(20, 0),
        training_end=at(49, 23),
        scoring_start=at(50, 0),
        scoring_end=at(69, 23),
        limit=3,
    )

    assert result["status"] == "succeeded"
    assert result["engine"]["library"] == "scikit-learn"
    payload = result["payload"]
    assert (payload["training_observations"], payload["scoring_observations"]) == (90, 60)
    top = payload["observations"]
    assert [row["rank"] for row in top] == [1, 2, 3]
    assert top[0]["cohort_percentile"] == 100.0
    # The crash and the high-volatility sessions after it are the most unusual.
    assert {row["asset_id"] for row in top} == {"asset-gamma"}
    crash = next(row for row in top if datetime.fromisoformat(row["timestamp"]) == at(GAMMA_SPIKE, 21))
    assert crash["is_anomaly"] and crash["decision_score"] < 0
    assert crash["observed_deviations"]["adjusted_return_1d"] < -10  # a far larger fall than in training
    assert crash["observed_deviations"]["log_volume_deviation_20d"] > 10


def test_anomaly_scan_filters_by_percentile_and_rejects_overlapping_windows(data: MarketData) -> None:
    windows = {"training_start": at(20, 0), "training_end": at(49, 23), "scoring_end": at(69, 23)}
    top_decile = run(
        data,
        "market_anomaly_scan",
        universe_id="reviewed_assets",
        scoring_start=at(50, 0),
        minimum_percentile=90,
        **windows,
    )
    assert all(row["cohort_percentile"] >= 90 for row in top_decile["payload"]["observations"])
    assert len(top_decile["payload"]["observations"]) == 7  # ranks 1-7 of 60 are at or above the 90th percentile

    overlapping = run(data, "market_anomaly_scan", universe_id="reviewed_assets", scoring_start=at(40, 0), **windows)
    assert overlapping["error"]["code"] == "invalid_request"


def test_price_context_summarizes_weekly_bars_for_tickers_and_names(data: MarketData) -> None:
    result = run(data, "price_context", asset_ids=["ALPH", "Beta Beverages"], frequency="weekly", point_limit=3, **JUNE)

    payload = result["payload"]
    assert [summary["asset_id"] for summary in payload["summaries"]] == ["asset-alpha", "asset-beta"]
    alpha = payload["summaries"][0]
    assert alpha["observation_count"] == 5  # five weeks overlap June
    # Weekly summaries run from the first week's close (Friday 2026-06-05) to the last (Tuesday 2026-06-30).
    assert datetime.fromisoformat(alpha["start_timestamp"]) == datetime(2026, 6, 5, 21, tzinfo=UTC)
    assert datetime.fromisoformat(alpha["end_timestamp"]) == datetime(2026, 6, 30, 21, tzinfo=UTC)
    assert alpha["total_return"] == pytest.approx(alpha["end_price"] / alpha["start_price"] - 1)
    assert len(payload["series"]) == 3 and payload["series_truncated"]
    assert result["warnings"] == ["The series is cut to the first 3 points."]
    assert payload["series"][0]["timestamp"] == alpha["start_timestamp"]


def test_price_context_rejects_unknown_assets(data: MarketData) -> None:
    result = run(data, "price_context", asset_ids=["ALPH", "NOPE"], **JUNE)
    assert result["error"] == {"code": "invalid_request", "message": "unknown asset 'NOPE'"}


def test_sentiment_timeline_counts_labels_per_period(data: MarketData) -> None:
    window = {"start": at(0, 0), "end": at(69, 23, 59)}
    result = run(data, "sentiment_timeline", frequency="monthly", **window)

    payload = result["payload"]
    assert payload["articles_considered"] == 8
    assert sum(point["article_count"] for point in payload["points"]) == 8
    for point in payload["points"]:
        assert point["positive_count"] + point["neutral_count"] + point["negative_count"] == point["article_count"]
    assert [point["period_start"][:10] for point in payload["points"]] == ["2026-06-01", "2026-07-01", "2026-08-01"]

    recent = run(data, "sentiment_timeline", frequency="monthly", point_limit=1, asset_ids=["asset-alpha"], **window)
    assert [point["period_start"][:10] for point in recent["payload"]["points"]] == ["2026-08-01"]
    assert recent["payload"]["points_truncated"]


def test_news_price_relationship_measures_forward_returns(data: MarketData) -> None:
    result = run(
        data,
        "analyze_news_price_relationship",
        published_from=at(0, 0),
        published_to=at(69, 23, 59),
        return_horizon_sessions=2,
        source_names=["Wire A"],
    )

    payload = result["payload"]
    # n-08 comes after the last close, and n-07's two-session horizon is inside the data, so 4 of 5 align.
    assert (payload["eligible_event_count"], payload["aligned_event_count"]) == (5, 4)
    assert payload["coverage_ratio"] == 0.8
    first = payload["events"][0]
    assert first["news_id"] == "n-01"
    closes = data.prices[data.prices["asset_id"] == "asset-alpha"].set_index("session")["adjusted_close"]
    assert first["forward_return"] == pytest.approx(closes[43] / closes[41] - 1)
    assert datetime.fromisoformat(first["aligned_session"]) == at(40, 21)
    assert datetime.fromisoformat(first["outcome_session"]) == at(42, 21)
    labels = {summary["sentiment_label"]: summary["event_count"] for summary in payload["summaries"]}
    assert labels == {"negative": 1, "neutral": 1, "positive": 2}
    assert -1 <= payload["sentiment_return_correlation"] <= 1


def test_news_price_relationship_without_aligned_events_is_empty(data: MarketData) -> None:
    result = run(data, "analyze_news_price_relationship", published_from=at(69, 22), published_to=at(69, 23))
    assert result["status"] == "empty"
    assert result["payload"]["eligible_event_count"] == 1
    assert result["warnings"] == ["No article had a complete forward-return window."]


def test_market_relationships_rank_pagerank_centrality(data: MarketData) -> None:
    result = run(data, "analyze_market_relationships", top_k=2)

    assert result["engine"]["library"] == "networkx"
    payload = result["payload"]
    assert (payload["node_count"], payload["edge_count"]) == (4, 12)
    assert payload["window_start"] == "2026-06-01"
    assert [asset["rank"] for asset in payload["central_assets"]] == [1, 2]
    assert payload["strongest_edges"][0]["source_asset_id"] == "asset-alpha"
    assert payload["strongest_edges"][0]["target_asset_id"] == "asset-beta"

    everyone = run(data, "analyze_market_relationships", top_k=50)["payload"]["central_assets"]
    assert math.isclose(sum(asset["centrality"] for asset in everyone), 1.0)
