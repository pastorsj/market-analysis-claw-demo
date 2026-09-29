# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""sentiment_timeline and analyze_news_price_relationship over the pack's short-form news labels."""

from __future__ import annotations

import math
from datetime import datetime

import pandas as pd

from ..data import SENTIMENT_SCORES
from ..data import MarketData
from ..models import Frequency
from ..models import NewsPriceEvent
from ..models import NewsPriceRelationshipPayload
from ..models import SentimentPoint
from ..models import SentimentReturnSummary
from ..models import SentimentTimelinePayload
from .common import Output
from .common import check_window
from .common import period_start

SENTIMENT_LIMITATIONS = (
    "Sentiment values are labels stored in the data pack, not model inference performed at query time.",
    "Narrative volume and observed sentiment are descriptive and do not establish a causal market explanation.",
)
NEWS_PRICE_LIMITATIONS = (
    "The analysis is descriptive correlation and does not establish causation.",
    "Publication timing, label quality, overlapping events and omitted variables can affect the relationship.",
    "Results are not investment advice.",
)


def sentiment_timeline(
    data: MarketData,
    *,
    start: datetime,
    end: datetime,
    asset_ids: list[str] | None = None,
    source_names: list[str] | None = None,
    frequency: Frequency = "weekly",
    point_limit: int = 100,
) -> Output:
    articles = _articles(data, start, end, asset_ids, source_names)
    if articles.empty:
        payload = SentimentTimelinePayload(
            frequency=frequency, articles_considered=0, points=[], points_truncated=False
        )
        return Output(payload, rows_scanned=0, empty=True, warnings=("No articles matched the filters and window.",))

    labels = articles["sentiment_label"]
    periods = (
        articles.assign(
            period_start=period_start(articles["published_at"], frequency),
            score=sentiment_score(labels),
            positive=labels == "positive",
            neutral=labels == "neutral",
            negative=labels == "negative",
        )
        .groupby("period_start")
        .agg(
            article_count=("news_id", "count"),
            positive_count=("positive", "sum"),
            neutral_count=("neutral", "sum"),
            negative_count=("negative", "sum"),
            mean_sentiment=("score", "mean"),
        )
        .reset_index()
    )
    recent = periods.tail(point_limit)
    payload = SentimentTimelinePayload(
        frequency=frequency,
        articles_considered=len(articles),
        points=[SentimentPoint(**row) for row in recent.to_dict("records")],
        points_truncated=len(recent) < len(periods),
    )
    warnings = (f"Only the most recent {point_limit} periods are returned.",) if payload.points_truncated else ()
    return Output(payload, rows_scanned=len(articles), warnings=warnings)


def news_price_relationship(
    data: MarketData,
    *,
    published_from: datetime,
    published_to: datetime,
    asset_ids: list[str] | None = None,
    source_names: list[str] | None = None,
    return_horizon_sessions: int = 2,
    event_limit: int = 25,
) -> Output:
    """Return from each article's first session at or after publication to `return_horizon_sessions` later."""
    articles = _articles(data, published_from, published_to, asset_ids, source_names)
    prices = data.prices[data.prices["asset_id"].isin(articles["asset_id"])]
    aligned = prices[["asset_id", "session", "timestamp", "adjusted_close"]]
    outcome = aligned.assign(session=aligned["session"] - return_horizon_sessions)
    events = articles.merge(aligned, on=["asset_id", "session"]).merge(
        outcome, on=["asset_id", "session"], suffixes=("", "_outcome")
    )
    events["forward_return"] = events["adjusted_close_outcome"] / events["adjusted_close"] - 1
    if events.empty:
        payload = NewsPriceRelationshipPayload(
            return_horizon_sessions=return_horizon_sessions,
            eligible_event_count=len(articles),
            aligned_event_count=0,
            coverage_ratio=0.0,
            sentiment_return_correlation=None,
            summaries=[],
            events=[],
            events_truncated=False,
        )
        warning = "No article had a complete forward-return window." if len(articles) else "No articles matched."
        return Output(payload, rows_scanned=len(articles), empty=True, warnings=(warning,))

    # A list of aggregations, renamed: cudf.pandas has no named aggregation on a single column.
    summaries = (
        events.groupby("sentiment_label")["forward_return"]
        .agg(["count", "mean", "median"])
        .rename(columns={"count": "event_count", "mean": "mean_forward_return", "median": "median_forward_return"})
        .reset_index()
    )
    correlation = sentiment_score(events["sentiment_label"]).corr(events["forward_return"])
    events = events.sort_values(["published_at", "news_id"])
    payload = NewsPriceRelationshipPayload(
        return_horizon_sessions=return_horizon_sessions,
        eligible_event_count=len(articles),
        aligned_event_count=len(events),
        coverage_ratio=len(events) / len(articles),
        sentiment_return_correlation=None if math.isnan(correlation) else correlation,
        summaries=[SentimentReturnSummary(**row) for row in summaries.to_dict("records")],
        events=[
            NewsPriceEvent(
                news_id=row["news_id"],
                asset_id=row["asset_id"],
                published_at=row["published_at"],
                sentiment_label=row["sentiment_label"],
                aligned_session=row["timestamp"],
                outcome_session=row["timestamp_outcome"],
                forward_return=row["forward_return"],
            )
            for row in events.head(event_limit).to_dict("records")
        ],
        events_truncated=len(events) > event_limit,
    )
    warnings = (f"Only the first {event_limit} aligned events are listed.",) if payload.events_truncated else ()
    return Output(payload, rows_scanned=len(articles), warnings=warnings)


def sentiment_score(labels: pd.Series) -> pd.Series:
    """negative=-1, neutral=0, positive=+1. Built from comparisons: under cudf.pandas, Series.map from strings to
    numbers falls back to pandas. The contract limits the labels to these three."""
    return sum((labels == label).astype("int64") * score for label, score in SENTIMENT_SCORES.items() if score)


def _articles(
    data: MarketData,
    start: datetime,
    end: datetime,
    asset_ids: list[str] | None,
    source_names: list[str] | None,
) -> pd.DataFrame:
    check_window(start, end)
    news = data.news
    # `selected = selected & ...`, not `&=`: cudf.pandas has no in-place `&` and would fall back to pandas.
    selected = news["published_at"].between(start, end)
    if asset_ids:
        selected = selected & news["asset_id"].isin(data.resolve_assets(asset_ids))
    if source_names:
        selected = selected & news["source_name"].isin(source_names)
    return news[selected]
