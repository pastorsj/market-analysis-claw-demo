# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""MCP server (streamable HTTP at :3010/mcp) exposing the market tools, plus GET /health.

The tools are async and hand each call to the worker process on a thread, so a long calculation never blocks
the event loop: `tools/list` and other requests stay responsive while calls queue for the worker.

No `from __future__ import annotations` here: the tool signatures use a type built from the pack at runtime
(UniverseId), which the MCP SDK must be able to resolve when it reads them.
"""

import logging
import os
import time
from pathlib import Path
from typing import Annotated
from typing import Any
from typing import Literal

import anyio.to_thread
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import AwareDatetime
from pydantic import BaseModel
from pydantic import Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from .data import ContractError
from .data import Pack
from .data import validate
from .models import Comparison
from .models import Direction
from .models import ErrorCode
from .models import Failure
from .models import Frequency
from .models import IntradayMetric
from .models import IntradayScanPayload
from .models import MarketAnomalyPayload
from .models import MarketRelationshipsPayload
from .models import MarketResult
from .models import MarketScanPayload
from .models import Metric
from .models import NewsPriceRelationshipPayload
from .models import PriceContextPayload
from .models import SentimentTimelinePayload
from .models import Timing
from .worker import Worker
from .worker import WorkerError

PORT = 3010
READ_ONLY = ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False)

logger = logging.getLogger(__name__)

Start = Annotated[AwareDatetime, Field(description="Window start, inclusive, with a timezone (2026-08-01T00:00:00Z)")]
End = Annotated[AwareDatetime, Field(description="Window end, inclusive, with a timezone (2026-08-31T23:59:59Z)")]
Assets = Annotated[list[str], Field(min_length=1, max_length=50, description="Asset ids, tickers or company names")]
OptionalAssets = Annotated[
    list[str] | None, Field(max_length=50, description="Only these assets (ids, tickers or company names)")
]
SourceNames = Annotated[list[str] | None, Field(max_length=20, description="Only articles from these news sources")]
SourceIds = Annotated[
    list[str] | None, Field(description="The sources selected for this run. The application sets it; leave it out.")
]
NO_NEWS = "Unavailable in the active data pack, which has no ticker-linked news table. "
NO_MINUTE_BARS = "Unavailable in the active data pack, which has no minute bars. "


def create_server(pack: Pack, worker: Worker) -> MCPServer:
    server = MCPServer(
        "market_analytics",
        instructions="Read-only market analytics over the active data pack. Results are descriptive, not advice.",
    )
    universe_help = "; ".join(f"{name}: {u.description.rstrip('.')}" for name, u in pack.universes.items())
    pick = "The asset universe to analyze: the one that matches the group the question names"
    UniverseId = Annotated[Literal[tuple(pack.universes)], Field(description=f"{pick}. {universe_help}")]
    OptionalUniverse = Annotated[
        Literal[tuple(pack.universes)] | None,
        Field(description=f"{pick}, when no asset_ids are named. {universe_help}"),
    ]
    news = "" if pack.news_table else NO_NEWS

    async def run_in_worker[P: BaseModel](
        tool: str, payload: type[P], source_ids: list[str] | None, **arguments: Any
    ) -> MarketResult[P]:
        started = time.perf_counter()

        def failed(code: ErrorCode, message: str) -> MarketResult[P]:
            return MarketResult[payload](
                operation_id=tool,
                status="failed",
                source_id=pack.source_id,
                database_name=pack.database_name,
                error=Failure(code=code, message=message),
                timing=Timing(compute_ms=0.0, total_ms=0.0),
            )

        if source_ids is not None and pack.source_id not in source_ids:
            result = failed("source_not_selected", f"{pack.source_id} is not one of the selected sources")
        else:
            try:
                result = MarketResult[payload].model_validate(
                    await anyio.to_thread.run_sync(worker.call, tool, arguments)
                )
            except TimeoutError as error:
                result = failed("deadline_exceeded", str(error))
            except WorkerError as error:
                result = failed("execution_failed", str(error))
        result.timing.total_ms = (time.perf_counter() - started) * 1000
        return result

    @server.tool(annotations=READ_ONLY)
    async def market_scan(
        *,
        universe_id: UniverseId,
        end: End,
        metrics: Annotated[list[Metric], Field(min_length=1, max_length=4, description="The first metric ranks")],
        start: Annotated[
            AwareDatetime | None, Field(description="Window start, inclusive, with a timezone; omit it with sessions")
        ] = None,
        sessions: Annotated[
            int | None, Field(ge=2, le=260, description="The number of trading sessions ending at end; replaces start")
        ] = None,
        comparison: Annotated[
            Comparison, Field(description="Rank the value, its magnitude, or its z-score")
        ] = "absolute",
        direction: Direction = "highest",
        limit: Annotated[int, Field(ge=1, le=100)] = 10,
        source_ids: SourceIds = None,
    ) -> MarketResult[MarketScanPayload]:
        """Rank a universe's assets by return, volume, volatility or peer-relative return over a window.

        Use direction=highest for leaders and direction=lowest for laggards; make two calls when both ends of the
        ranking are needed. The other metrics are reported next to the ranking one. Returns and volatility are
        fractions (0.25 is 25%; volatility is the daily standard deviation). For "the N sessions ending D", pass
        end=D and sessions=N instead of start.
        """
        return await run_in_worker(
            "market_scan",
            MarketScanPayload,
            source_ids,
            universe_id=universe_id,
            start=start,
            end=end,
            sessions=sessions,
            metrics=metrics,
            comparison=comparison,
            direction=direction,
            limit=limit,
        )

    @server.tool(annotations=READ_ONLY)
    async def market_anomaly_scan(
        *,
        universe_id: UniverseId,
        training_start: Annotated[AwareDatetime, Field(description="Baseline window start, with a timezone")],
        training_end: Annotated[AwareDatetime, Field(description="Baseline window end; before scoring_start")],
        scoring_start: Annotated[AwareDatetime, Field(description="Scored window start, with a timezone")],
        scoring_end: Annotated[AwareDatetime, Field(description="Scored window end, with a timezone")],
        limit: Annotated[int, Field(ge=1, le=25)] = 10,
        minimum_percentile: Annotated[float | None, Field(ge=0, le=100)] = None,
        source_ids: SourceIds = None,
    ) -> MarketResult[MarketAnomalyPayload]:
        """Find sessions whose price and volume behavior differs from an earlier baseline window.

        Use it for unusual observed behavior, not for leaders and laggards or for predictions. Scores measure how
        unusual a session was; they are not probabilities, forecasts or evidence of a cause. observed_deviations
        are robust z-scores against the baseline window, not returns or percentages.
        """
        return await run_in_worker(
            "market_anomaly_scan",
            MarketAnomalyPayload,
            source_ids,
            universe_id=universe_id,
            training_start=training_start,
            training_end=training_end,
            scoring_start=scoring_start,
            scoring_end=scoring_end,
            limit=limit,
            minimum_percentile=minimum_percentile,
        )

    @server.tool(annotations=READ_ONLY)
    async def price_context(
        *,
        asset_ids: Assets,
        start: Start,
        end: End,
        frequency: Frequency = "daily",
        include_series: bool = True,
        point_limit: Annotated[int, Field(ge=1, le=2000)] = 250,
        source_ids: SourceIds = None,
    ) -> MarketResult[PriceContextPayload]:
        """Summarize return, price range and volume for named assets over a window, with an optional price series.

        Weekly and monthly series hold each period's last adjusted close and its total volume.
        """
        return await run_in_worker(
            "price_context",
            PriceContextPayload,
            source_ids,
            asset_ids=asset_ids,
            start=start,
            end=end,
            frequency=frequency,
            include_series=include_series,
            point_limit=point_limit,
        )

    @server.tool(
        annotations=READ_ONLY,
        description=(
            f"{news}Count positive, neutral and negative news labels per day, week or month over a publication "
            "window. Name asset_ids or a universe_id to count only their news. The labels are stored with the news; "
            "the timeline is descriptive and does not explain market moves."
        ),
    )
    async def sentiment_timeline(
        *,
        start: Start,
        end: End,
        asset_ids: OptionalAssets = None,
        universe_id: OptionalUniverse = None,
        source_names: SourceNames = None,
        frequency: Frequency = "weekly",
        point_limit: Annotated[int, Field(ge=1, le=500, description="Keep the most recent periods")] = 100,
        source_ids: SourceIds = None,
    ) -> MarketResult[SentimentTimelinePayload]:
        return await run_in_worker(
            "sentiment_timeline",
            SentimentTimelinePayload,
            source_ids,
            start=start,
            end=end,
            asset_ids=asset_ids,
            universe_id=universe_id,
            source_names=source_names,
            frequency=frequency,
            point_limit=point_limit,
        )

    @server.tool(
        annotations=READ_ONLY,
        description=(
            f"{news}Relate news sentiment labels to the returns that followed them. Each article is aligned with "
            "its asset's first session at or after publication, and its forward return runs to "
            "return_horizon_sessions sessions later. Name asset_ids or a universe_id to use only their news. "
            "Reports per-label averages and the sentiment/return correlation. Correlation does not establish "
            "causation."
        ),
    )
    async def analyze_news_price_relationship(
        *,
        published_from: Start,
        published_to: End,
        asset_ids: OptionalAssets = None,
        universe_id: OptionalUniverse = None,
        source_names: SourceNames = None,
        return_horizon_sessions: Annotated[int, Field(ge=1, le=20)] = 2,
        event_limit: Annotated[int, Field(ge=1, le=500, description="How many aligned events to list")] = 25,
        source_ids: SourceIds = None,
    ) -> MarketResult[NewsPriceRelationshipPayload]:
        return await run_in_worker(
            "analyze_news_price_relationship",
            NewsPriceRelationshipPayload,
            source_ids,
            published_from=published_from,
            published_to=published_to,
            asset_ids=asset_ids,
            universe_id=universe_id,
            source_names=source_names,
            return_horizon_sessions=return_horizon_sessions,
            event_limit=event_limit,
        )

    start, end = pack.graph_window

    @server.tool(
        annotations=READ_ONLY,
        description=(
            f"Rank assets by PageRank centrality in the fixed graph of daily-return correlations from {start} to "
            f"{end}, and list its strongest links. The graph covers the whole dataset and cannot be limited to a "
            "universe or window; for correlations within a chosen group of assets, query the database instead."
        ),
    )
    async def analyze_market_relationships(
        top_k: Annotated[int, Field(ge=1, le=50, description="How many assets and links to return")] = 10,
        source_ids: SourceIds = None,
    ) -> MarketResult[MarketRelationshipsPayload]:
        return await run_in_worker("analyze_market_relationships", MarketRelationshipsPayload, source_ids, top_k=top_k)

    @server.tool(
        annotations=READ_ONLY,
        description=(
            f"{'' if pack.minute_bars else NO_MINUTE_BARS}Rank asset sessions by how they traded minute by minute "
            "in the regular session: intraday range, realized volatility, open-to-close return, the deepest drawdown "
            "from the session's running high, or volume. Name asset_ids, or a universe_id to scan every asset in "
            "it. Each session also reports its VWAP and the share of its volume in the first and last 30 minutes. "
            "Ranges, returns, drawdowns and volume shares are fractions (0.05 is 5%). "
            "It reads the raw minute bars in place, batch by batch."
        ),
    )
    async def intraday_scan(
        *,
        start: Start,
        end: End,
        asset_ids: OptionalAssets = None,
        universe_id: OptionalUniverse = None,
        rank_by: Annotated[IntradayMetric, Field(description="The metric that ranks the sessions")] = "intraday_range",
        direction: Direction = "highest",
        limit: Annotated[int, Field(ge=1, le=100)] = 10,
        source_ids: SourceIds = None,
    ) -> MarketResult[IntradayScanPayload]:
        return await run_in_worker(
            "intraday_scan",
            IntradayScanPayload,
            source_ids,
            start=start,
            end=end,
            asset_ids=asset_ids,
            universe_id=universe_id,
            rank_by=rank_by,
            direction=direction,
            limit=limit,
        )

    @server.custom_route("/health", methods=["GET"])
    async def health(_: Request) -> JSONResponse:
        """Healthy while the worker process is up; a dead worker is replaced by the next call."""
        return JSONResponse({"worker": worker.pid, "alive": worker.alive}, status_code=200 if worker.alive else 503)

    return server


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(processName)s %(name)s: %(message)s")
    # /data/active is a symlink that moves when the data one-shot activates another build. Resolve it once, so a
    # replacement worker loads the same build that the tool schemas describe.
    root = Path(os.environ.get("DATA_ACTIVE_DIR", "/data/active")).resolve()
    pack = Pack.load(root)
    try:
        validate(pack)
    except ContractError as error:
        raise SystemExit(str(error)) from None
    worker = Worker(root, timeout=float(os.environ.get("MARKET_ANALYTICS_TIMEOUT_SECONDS", "120")))
    worker.start()
    server = create_server(pack, worker)
    if url := os.environ.get("KUMO_RELATIONAL_URL"):
        from .prediction import register  # only with the optional kumo extra

        register(server, pack, url, api_key=os.environ.get("KUMO_API_KEY") or None)
    logger.info("serving %s (%s) on :%d/mcp", pack.source_id, root, PORT)
    try:
        server.run("streamable-http", host="0.0.0.0", port=PORT, json_response=True)
    finally:
        worker.close()
