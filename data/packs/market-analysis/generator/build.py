#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Generate the deterministic synthetic market for the market-analysis pack.

    python build.py --profile qualification --out <dir>

Writes <dir>/<table>.parquet for every table in pack.yaml. The profile (issuer count, history window, news
sampling, peer graph shape) comes from pack.yaml `generator.profiles`; everything else comes from
generation-spec.v1.json and news-analytics-spec.v1.json next to this file. The same seed always produces the
same rows: every random draw is a SHA-256 of the seed and the row's identity.

Prices are simulated from `simulation_start` for every profile and only the profile's window is kept, so the
twelve story assets have identical prices in every profile.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
from collections.abc import Iterable
from collections.abc import Iterator
from collections.abc import Mapping
from datetime import UTC
from datetime import date
from datetime import datetime
from datetime import timedelta
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import yaml

HERE = Path(__file__).resolve().parent
PACK_DIR = HERE.parent
DATABASE_TABLES = (
    "assets",
    "ticker_history",
    "trading_sessions",
    "daily_prices",
    "corporate_actions",
    "news_articles",
    "asset_relationships",
    "index_memberships",
)
PRICE_SCHEMA = pa.schema(
    [
        ("price_id", pa.string()),
        ("asset_id", pa.string()),
        ("trading_date", pa.date32()),
        ("exchange", pa.string()),
        ("raw_open", pa.float64()),
        ("raw_high", pa.float64()),
        ("raw_low", pa.float64()),
        ("raw_close", pa.float64()),
        ("adjusted_close", pa.float64()),
        ("volume", pa.int64()),
        ("cumulative_split_factor", pa.float64()),
        ("dividend_amount_usd", pa.float64()),
        ("total_return_1d", pa.float64()),
        ("ingested_at", pa.timestamp("us", tz="UTC")),
    ]
)
MARKET_NEWS_SCHEMA = pa.schema(
    [
        ("news_id", pa.string()),
        ("document_id", pa.string()),
        ("primary_asset_id", pa.string()),
        ("alignment_session_number", pa.int64()),
        ("ticker", pa.string()),
        ("company_name", pa.string()),
        ("sector", pa.string()),
        ("industry", pa.string()),
        ("region", pa.string()),
        ("published_at", pa.timestamp("us", tz="UTC")),
        ("source_name", pa.string()),
        ("headline", pa.string()),
        ("text", pa.string()),
        ("event_type", pa.string()),
        ("sentiment_label", pa.string()),
        ("synthetic", pa.bool_()),
    ]
)


def stable_unit(seed: str) -> float:
    """A deterministic draw in [0, 1] from a string."""
    value = int.from_bytes(hashlib.sha256(seed.encode()).digest()[:8], "big")
    return value / float(2**64 - 1)


def utc_at(day: date, **offset: int) -> datetime:
    return datetime.combine(day, datetime.min.time(), tzinfo=UTC) + timedelta(**offset)


def expand_assets(spec: Mapping[str, Any], asset_count: int) -> list[dict[str, Any]]:
    """The story assets plus unique scale issuers cycled from them; scale issuers never replay story rows."""
    story = list(spec["assets"])
    assets = [dict(asset, is_reviewed=True) for asset in story]
    for ordinal in range(1, asset_count - len(story) + 1):
        archetype = story[(ordinal - 1) % len(story)]
        stable = stable_unit(f"{spec['seed']}:qualification-asset:{ordinal}")
        assets.append(
            {
                "asset_id": f"asset-qualification-{ordinal:04d}",
                "ticker": f"Q{ordinal:04d}",
                "company_name": f"Synthetic Qualification Issuer {ordinal:04d}",
                "sector": archetype["sector"],
                "industry": f"Synthetic {archetype['industry']}",
                "exchange": archetype["exchange"],
                "currency": "USD",
                "region": archetype["region"],
                "base_price": round(float(archetype["base_price"]) * (0.75 + stable * 0.5), 6),
                "annual_drift": round(float(archetype["annual_drift"]) * (0.7 + stable * 0.6), 8),
                "daily_volatility": round(float(archetype["daily_volatility"]) * (0.75 + (1.0 - stable) * 0.5), 8),
                "is_reviewed": False,
            }
        )
    return assets


def trading_days(spec: Mapping[str, Any], start: date) -> list[date]:
    """Weekdays from `start` through `analysis_as_of`, minus exchange holidays."""
    end = date.fromisoformat(spec["analysis_as_of"])
    holidays = {date.fromisoformat(day) for day in spec["holidays"]}
    days = (start + timedelta(days=offset) for offset in range((end - start).days + 1))
    return [day for day in days if day.weekday() < 5 and day not in holidays]


def price_rows(spec: Mapping[str, Any], assets: list[dict[str, Any]], keep_from: date) -> Iterator[tuple[Any, ...]]:
    """Simulate one canonical history per asset and yield the rows on or after `keep_from`."""
    seed = spec["seed"]
    sessions = trading_days(spec, date.fromisoformat(spec["simulation_start"]))
    event_impacts = {
        (event["asset_id"], datetime.fromisoformat(event["published_at"]).date()): float(event["price_impact"])
        for event in spec["events"]
    }
    actions = {
        (action["asset_id"], date.fromisoformat(action["effective_date"])): action
        for action in spec["corporate_actions"]
    }
    for asset_index, asset in enumerate(assets):
        asset_id = asset["asset_id"]
        adjusted_close = float(asset["base_price"])
        prior_adjusted = adjusted_close
        cumulative_split = 1.0
        for session_index, day in enumerate(sessions):
            key = f"{asset_id}:{day.isoformat()}"
            idiosyncratic = (2.0 * stable_unit(f"{seed}:{key}") - 1.0) * float(asset["daily_volatility"])
            market_cycle = 0.0045 * math.sin((session_index + asset_index * 3) / 19.0)
            event_impact = event_impacts.get((asset_id, day), 0.0)
            daily_drift = float(asset["annual_drift"]) / 252.0
            adjusted_close = max(
                4.0, adjusted_close * (1.0 + daily_drift + idiosyncratic + market_cycle + event_impact)
            )
            dividend = 0.0
            if action := actions.get((asset_id, day)):
                cumulative_split *= float(action["split_ratio"])
                dividend = float(action["cash_amount_usd"])
            if day < keep_from:
                prior_adjusted = adjusted_close
                continue
            raw_close = adjusted_close / cumulative_split
            raw_open = raw_close * (1.0 + (2.0 * stable_unit(f"open:{seed}:{key}") - 1.0) * 0.008)
            spread = 0.006 + stable_unit(f"spread:{seed}:{key}") * 0.018
            volume = int(500_000 + 2_500_000 * stable_unit(f"volume:{seed}:{key}") + abs(event_impact) * 30_000_000)
            total_return = (adjusted_close + dividend) / prior_adjusted - 1.0 if session_index else 0.0
            yield (
                f"price-{asset_id.removeprefix('asset-')}-{day.isoformat()}",
                asset_id,
                day,
                asset["exchange"],
                round(raw_open, 4),
                round(max(raw_open, raw_close) * (1.0 + spread), 4),
                round(min(raw_open, raw_close) * (1.0 - spread), 4),
                round(raw_close, 4),
                round(adjusted_close, 4),
                volume,
                round(cumulative_split, 4),
                round(dividend, 4),
                round(total_return, 8),
                utc_at(day, hours=22),
            )
            prior_adjusted = adjusted_close


def price_batches(rows: Iterable[tuple[Any, ...]], size: int = 50_000) -> Iterator[pa.RecordBatch]:
    iterator = iter(rows)
    while batch := list(itertools.islice(iterator, size)):
        columns = zip(*batch, strict=True)
        yield pa.record_batch(
            [pa.array(column, type=field.type) for column, field in zip(columns, PRICE_SCHEMA, strict=True)],
            schema=PRICE_SCHEMA,
        )


def relationship_rows(
    spec: Mapping[str, Any], assets: list[dict[str, Any]], params: Mapping[str, Any], start: date
) -> list[tuple[Any, ...]]:
    """Declared peers: a deterministic ring at scale, or the curated peer groups for the story universe."""
    if params["relationship_mode"] == "sparse_declared_peers":
        ids = [asset["asset_id"] for asset in assets]
        return [
            (
                f"peer-qualification-{index + 1:04d}-{neighbor:02d}",
                source,
                ids[(index + neighbor) % len(ids)],
                "deterministic_market_peer",
                start,
                None,
            )
            for index, source in enumerate(ids)
            for neighbor in range(1, params["relationship_neighbors"] + 1)
        ]
    rows: list[tuple[Any, ...]] = []
    seen: set[tuple[str, ...]] = set()
    for group_index, group in enumerate(spec["peer_groups"], start=1):
        for left_index, source in enumerate(group):
            for target in group[left_index + 1 :]:
                pair = tuple(sorted((source, target)))
                if pair not in seen:
                    seen.add(pair)
                    rows.append((f"peer-{group_index}-{len(rows) + 1:03d}", *pair, "operating_peer", start, None))
    return rows


def market_news_rows(
    connection: duckdb.DuckDBPyConnection, seed: str, news_spec: Mapping[str, Any], sample_every: int
) -> list[dict[str, Any]]:
    """Short-form news: one item per asset every `sample_every` sessions, described from observed prices.

    The sentiment label is computed from the trailing five-session return, so it is descriptive, not predictive.
    """
    warmup = news_spec["minimum_history_sessions"]
    cursor = connection.execute(
        """
        WITH measured AS (
          SELECT p.asset_id, a.company_name, a.sector, a.industry, a.region, t.ticker,
            p.trading_date, p.adjusted_close, p.volume,
            ROW_NUMBER() OVER (PARTITION BY p.asset_id ORDER BY p.trading_date) AS session_number,
            LAG(p.adjusted_close, 5) OVER (PARTITION BY p.asset_id ORDER BY p.trading_date) AS close_5_sessions_ago,
            STDDEV_SAMP(p.total_return_1d) OVER (
              PARTITION BY p.asset_id ORDER BY p.trading_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
            ) * SQRT(252.0) AS annualized_volatility_20d,
            AVG(p.volume) OVER (
              PARTITION BY p.asset_id ORDER BY p.trading_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
            ) AS average_volume_20d
          FROM main.daily_prices p
          JOIN main.assets a ON a.asset_id = p.asset_id
          JOIN main.ticker_history t ON t.asset_id = p.asset_id
            AND t.effective_from <= p.trading_date
            AND (t.effective_to IS NULL OR t.effective_to > p.trading_date)
        )
        SELECT * FROM measured
        WHERE session_number >= ? AND (session_number - ?) % ? = 0
        ORDER BY asset_id, trading_date
        """,
        [warmup, warmup, sample_every],
    )
    names = [column[0] for column in cursor.description]
    sources, themes = news_spec["sources"], news_spec["themes"]
    rows = []
    for values in cursor.fetchall():
        item = dict(zip(names, values, strict=True))
        asset_id, day = item["asset_id"], item["trading_date"]
        stable = hashlib.sha256(f"{seed}:news:{asset_id}:{day.isoformat()}".encode()).digest()
        theme = themes[int.from_bytes(stable[:4], "big") % len(themes)]
        five_session_return = float(item["adjusted_close"] / item["close_5_sessions_ago"] - 1.0)
        volatility = float(item["annualized_volatility_20d"] or 0.0)
        average_volume = float(item["average_volume_20d"] or 0.0)
        volume_ratio = float(item["volume"] / average_volume) if average_volume else 0.0
        direction = "higher" if five_session_return > 0.002 else "lower" if five_session_return < -0.002 else "steady"
        sentiment = (
            "positive" if five_session_return > 0.015 else "negative" if five_session_return < -0.015 else "neutral"
        )
        news_id = f"market-pulse-{asset_id.removeprefix('asset-')}-{day.isoformat()}"
        rows.append(
            {
                "news_id": news_id,
                "document_id": f"short-form:{news_id}",
                "primary_asset_id": asset_id,
                # Published after the close, so the first session that can react is the next one.
                "alignment_session_number": item["session_number"] + 1,
                "ticker": item["ticker"],
                "company_name": item["company_name"],
                "sector": item["sector"],
                "industry": item["industry"],
                "region": item["region"],
                "published_at": utc_at(day, hours=21, minutes=15 + stable[8] % 40),
                "source_name": sources[int.from_bytes(stable[4:8], "big") % len(sources)],
                "headline": f"{item['company_name']} {theme['headline']} after a {direction} five-session move",
                "text": (
                    f"Synthetic short-form market evidence for {item['company_name']} ({item['ticker']}) on "
                    f"{day.isoformat()}. Adjusted close was ${float(item['adjusted_close']):.2f}; the prior "
                    f"five-session adjusted return was {five_session_return:+.2%}, trailing 20-session annualized "
                    f"volatility was {volatility:.2%}, and volume was {volume_ratio:.2f} times its trailing "
                    f"20-session average. {theme['narrative']} This synthetic observation is descriptive, is not "
                    "causal evidence, and is not investment advice."
                ),
                "event_type": theme["id"],
                "sentiment_label": sentiment,
                "synthetic": True,
            }
        )
    return rows


def generate(profile: str, out: Path) -> None:
    pack = yaml.safe_load((PACK_DIR / "pack.yaml").read_text(encoding="utf-8"))
    params = pack["generator"]["profiles"][profile]["params"]
    spec = json.loads((HERE / "generation-spec.v1.json").read_text(encoding="utf-8"))
    news_spec = json.loads((HERE / "news-analytics-spec.v1.json").read_text(encoding="utf-8"))
    start = date.fromisoformat(params["history_start"])
    if start < date.fromisoformat(spec["simulation_start"]):
        raise SystemExit(f"profile {profile} starts before simulation_start {spec['simulation_start']}")
    assets = expand_assets(spec, params["asset_count"])
    story_count = sum(asset["is_reviewed"] for asset in assets)
    sessions = trading_days(spec, start)

    with duckdb.connect() as db:
        db.execute((PACK_DIR / pack["structured"]["schema"]).read_text(encoding="utf-8"))
        db.executemany(
            "INSERT INTO main.assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    a["asset_id"],
                    a["company_name"],
                    a["sector"],
                    a["industry"],
                    a["exchange"],
                    a["currency"],
                    a["region"],
                    start,
                    None,
                    a["is_reviewed"],
                )
                for a in assets
            ],
        )
        db.executemany(
            "INSERT INTO main.ticker_history VALUES (?, ?, ?, ?, ?)",
            [
                (f"ticker-{a['asset_id'].removeprefix('asset-')}-001", a["asset_id"], a["ticker"], start, None)
                for a in assets
            ],
        )
        db.executemany(
            "INSERT INTO main.trading_sessions VALUES (?, ?, ?, ?, ?)",
            [
                (f"session-{exchange.casefold()}-{day.isoformat()}", exchange, day, "open", utc_at(day, hours=21))
                for exchange in sorted({asset["exchange"] for asset in assets})
                for day in sessions
            ],
        )
        prices = pa.RecordBatchReader.from_batches(PRICE_SCHEMA, price_batches(price_rows(spec, assets, start)))
        db.register("generated_prices", prices)
        db.execute("INSERT INTO main.daily_prices BY POSITION SELECT * FROM generated_prices")
        db.unregister("generated_prices")
        db.executemany(
            "INSERT INTO main.corporate_actions VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    a["action_id"],
                    a["asset_id"],
                    date.fromisoformat(a["effective_date"]),
                    a["action_type"],
                    a["split_ratio"],
                    a["cash_amount_usd"],
                )
                for a in spec["corporate_actions"]
            ],
        )
        db.executemany(
            "INSERT INTO main.news_articles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    e["article_id"],
                    e["asset_id"],
                    e["document_id"],
                    datetime.fromisoformat(e["published_at"]),
                    datetime.fromisoformat(e["ingested_at"]),
                    e["source_name"],
                    e["headline"],
                    e["event_type"],
                    e["sentiment"],
                )
                for e in spec["events"]
            ],
        )
        db.executemany(
            "INSERT INTO main.asset_relationships VALUES (?, ?, ?, ?, ?, ?)",
            relationship_rows(spec, assets, params, start),
        )
        db.executemany(
            "INSERT INTO main.index_memberships VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    f"membership-{a['asset_id'].removeprefix('asset-')}",
                    a["asset_id"],
                    "Accelerated Economy 12" if a["is_reviewed"] else "Synthetic Qualification Expansion",
                    start,
                    None,
                    round(1.0 / (story_count if a["is_reviewed"] else len(assets) - story_count), 8),
                )
                for a in assets
            ],
        )
        news = market_news_rows(db, spec["seed"], news_spec, params["news_sample_every_sessions"])

        out.mkdir(parents=True, exist_ok=True)
        for table in DATABASE_TABLES:
            db.execute(f"COPY main.{table} TO ? (FORMAT PARQUET, COMPRESSION ZSTD)", [str(out / f"{table}.parquet")])
    news_path = out / f"{pack['analytics']['news_table']}.parquet"
    pq.write_table(pa.Table.from_pylist(news, schema=MARKET_NEWS_SCHEMA), news_path, compression="zstd")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    generate(args.profile, args.out)


if __name__ == "__main__":
    main()
