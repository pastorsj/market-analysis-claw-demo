# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Argument types and results of the market tools.

Every tool returns a `MarketResult`: the tool's payload plus what the execution receipt shows (source, engine,
timing, rows scanned). Failures are results too (`status="failed"`), because MCP clients drop the structured
content of an error response.
"""

from __future__ import annotations

from datetime import UTC
from datetime import date
from datetime import datetime
from typing import Annotated
from typing import Literal

from pydantic import AfterValidator
from pydantic import BaseModel
from pydantic import Field

Metric = Literal["return", "volume", "volatility", "peer_relative_return"]
Comparison = Literal["absolute", "magnitude", "zscore"]
Direction = Literal["highest", "lowest"]
Frequency = Literal["daily", "weekly", "monthly"]
SentimentLabel = Literal["positive", "neutral", "negative"]
ErrorCode = Literal["invalid_request", "source_not_selected", "deadline_exceeded", "execution_failed"]
MAX_MESSAGE_LENGTH = 1_000  # what the execution receipt accepts for an error message


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


# The worker computes on naive UTC timestamps (see data.py); results carry the UTC offset again, so they
# serialize as ISO 8601 with "Z" (2026-08-24T21:00:00Z).
UtcDatetime = Annotated[datetime, AfterValidator(_as_utc)]


class InvalidRequest(ValueError):
    """The arguments are well-formed but cannot be answered, e.g. an unknown asset or an empty window."""


class Engine(BaseModel):
    device: Literal["cpu", "gpu"]
    library: str = Field(description="pandas, scikit-learn and networkx on CPU; cudf.pandas, cuml.accel, nx-cugraph")
    version: str


class Timing(BaseModel):
    compute_ms: float = Field(description="Time the worker spent computing the result")
    total_ms: float = Field(description="End to end, including queueing for the worker")


def _clipped(message: str) -> str:
    return message if len(message) <= MAX_MESSAGE_LENGTH else message[: MAX_MESSAGE_LENGTH - 1] + "…"


class Failure(BaseModel):
    code: ErrorCode
    message: Annotated[str, AfterValidator(_clipped)]


class MarketResult[PayloadT: BaseModel](BaseModel):
    operation_id: str
    status: Literal["succeeded", "empty", "failed"]
    source_id: str
    database_name: str
    payload: PayloadT | None = None
    error: Failure | None = None
    engine: Engine | None = None
    timing: Timing
    rows_scanned: int = Field(0, description="Input rows the calculation ran over")
    warnings: list[str] = []
    limitations: list[str] = []


# market_scan


class RankedAsset(BaseModel):
    rank: int
    asset_id: str
    score: float
    values: dict[Metric, float | None]
    observation_count: int
    coverage_ratio: float = Field(description="Observations relative to the best-covered asset")


class MarketScanPayload(BaseModel):
    universe_id: str
    primary_metric: Metric
    comparison: Comparison
    direction: Direction
    assets_ranked: int
    observations: list[RankedAsset]


# market_anomaly_scan


class AnomalyObservation(BaseModel):
    rank: int
    asset_id: str
    timestamp: UtcDatetime
    anomaly_score: float = Field(description="PCA reconstruction error; higher is more unusual")
    decision_score: float = Field(description="Threshold minus score; negative means flagged")
    cohort_percentile: float
    is_anomaly: bool
    observed_deviations: dict[str, float] = Field(description="Robust z-score of each feature against training")


class MarketAnomalyPayload(BaseModel):
    universe_id: str
    feature_names: list[str]
    training_observations: int
    scoring_observations: int
    flagged_observations: int
    observations: list[AnomalyObservation]


# price_context


class AssetPriceSummary(BaseModel):
    asset_id: str
    start_timestamp: UtcDatetime
    end_timestamp: UtcDatetime
    start_price: float
    end_price: float
    total_return: float
    minimum_price: float
    maximum_price: float
    average_volume: float
    observation_count: int


class PricePoint(BaseModel):
    asset_id: str
    timestamp: UtcDatetime
    adjusted_close: float
    volume: float


class PriceContextPayload(BaseModel):
    frequency: Frequency
    summaries: list[AssetPriceSummary]
    series: list[PricePoint]
    series_truncated: bool


# sentiment_timeline


class SentimentPoint(BaseModel):
    period_start: UtcDatetime
    article_count: int
    positive_count: int
    neutral_count: int
    negative_count: int
    mean_sentiment: float = Field(description="Mean of negative=-1, neutral=0, positive=+1")


class SentimentTimelinePayload(BaseModel):
    frequency: Frequency
    articles_considered: int
    points: list[SentimentPoint]
    points_truncated: bool


# analyze_news_price_relationship


class NewsPriceEvent(BaseModel):
    news_id: str
    asset_id: str
    published_at: UtcDatetime
    sentiment_label: SentimentLabel
    aligned_session: UtcDatetime
    outcome_session: UtcDatetime
    forward_return: float


class SentimentReturnSummary(BaseModel):
    sentiment_label: SentimentLabel
    event_count: int
    mean_forward_return: float
    median_forward_return: float


class NewsPriceRelationshipPayload(BaseModel):
    return_horizon_sessions: int
    eligible_event_count: int
    aligned_event_count: int
    coverage_ratio: float
    sentiment_return_correlation: float | None
    summaries: list[SentimentReturnSummary]
    events: list[NewsPriceEvent]
    events_truncated: bool


# analyze_market_relationships


class CentralAsset(BaseModel):
    rank: int
    asset_id: str
    centrality: float = Field(description="PageRank score; all scores sum to 1")


class RelationshipEdge(BaseModel):
    source_asset_id: str
    target_asset_id: str
    correlation: float


class MarketRelationshipsPayload(BaseModel):
    window_start: date
    window_end: date
    node_count: int
    edge_count: int
    central_assets: list[CentralAsset]
    strongest_edges: list[RelationshipEdge]
