# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Round trip of the real market-analysis pack at the interactive profile: generate, load, publish, check."""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pytest
import yaml

from demo_data.cli import main
from demo_data.pack import DATA_ROOT
from demo_data.structured import check_tables

pytestmark = pytest.mark.slow

ANCHOR = "2026-08-24 21:00:00+00"
ORACLE_ROWS = {
    "anchor_news_eligibility.sql": 4,
    "event_price_reactions.sql": 8,
    "recent_adjusted_returns.sql": 12,
    "reviewed_currency_coverage.sql": 1,
    "sector_performance.sql": 5,
    "split_adjustment_continuity.sql": 1,
}


@pytest.fixture(scope="module")
def build(tmp_path_factory) -> Path:
    data = tmp_path_factory.mktemp("data")
    assert main(["--data-dir", str(data), "prepare", "--structured", "--profile", "interactive"]) == 0
    return (data / "active").resolve()


@pytest.fixture(scope="module")
def database(build):
    with duckdb.connect(str(build / "structured" / "market_analysis.duckdb"), read_only=True) as connection:
        yield connection


def test_the_build_has_the_profiles_rows_and_verifies(build):
    pack = json.loads((build / "pack.json").read_text())
    rows = pack["parts"]["structured"]["rows"]

    assert (rows["assets"], rows["daily_prices"], rows["market_news"]) == (12, 5004, 960)
    assert main(["--data-dir", str(build.parents[1]), "verify"]) == 0


def test_the_database_is_written_in_the_pinned_storage_format(database):
    (tags,) = database.execute("SELECT tags FROM duckdb_databases() WHERE database_name = 'market_analysis'").fetchone()
    assert tags == {"storage_version": "v1.0.0+"}


def test_prediction_views_see_nothing_after_the_anchor(database):
    after_anchor = {
        "price_events": "observed_at",
        "news_events": "published_at",
        "return_outcomes": "realized_at",
    }
    for view, column in after_anchor.items():
        query = f"SELECT count(*) FROM prediction.{view} WHERE {column} > TIMESTAMPTZ '{ANCHOR}'"
        assert database.execute(query).fetchone() == (0,), view
    population = database.execute("SELECT asset_id FROM prediction.reviewed_asset_population ORDER BY 1").fetchall()
    assert len(population) == 12


def test_sql_oracles_return_their_rows(database):
    oracles = DATA_ROOT / "packs" / "market-analysis" / "eval" / "oracles"
    counts = {
        path.name: database.execute(f"SELECT count(*) FROM ({path.read_text().strip().rstrip(';')})").fetchone()[0]
        for path in sorted(oracles.glob("*.sql"))
    }
    assert counts == ORACLE_ROWS


def test_a_split_moves_the_raw_price_but_not_the_adjusted_one(database):
    oracle = DATA_ROOT / "packs" / "market-analysis" / "eval" / "oracles" / "split_adjustment_continuity.sql"
    ((asset, _, _, raw_change, adjusted_change),) = database.execute(oracle.read_text()).fetchall()
    assert asset == "asset-galena"
    assert raw_change < -0.45
    assert abs(adjusted_change) < 0.10


def test_ontology_and_prediction_artifacts(build):
    model = yaml.safe_load((build / "ontology" / "model.yaml").read_text())
    schemas = {schema["name"]: schema for schema in model["data_layer"]["databases"][0]["schemas"]}
    graph = json.loads((build / "prediction" / "graph.json").read_text())
    templates = json.loads((build / "prediction" / "templates.json").read_text())["templates"]

    assert [len(schemas["main"]["tables"]), len(schemas["prediction"]["tables"])] == [8, 4]
    assert {table["type"] for table in schemas["prediction"]["tables"]} == {"VIEW"}
    assert len(model["semantic_layer"]["terms"]) == 8
    assert {table["name"]: table["rows"] for table in graph["tables"]} == {
        "asset_entities": 12,
        "price_events": 4944,
        "news_events": 4,
        "return_outcomes": 4884,
    }
    assert [template["id"] for template in templates] == ["positive_return", "material_downside", "news_event"]


def test_the_built_tables_satisfy_the_contract(build, market_pack, contract):
    assert check_tables(market_pack, "interactive", [contract], build / "tables")["market_news"] == 960


def test_generation_is_deterministic(build, tmp_path, market_pack):
    main(["--data-dir", str(tmp_path), "prepare", "--structured", "--profile", "interactive"])
    again = (tmp_path / "active").resolve()
    with duckdb.connect() as connection:
        for table in market_pack.tables:
            query = "SELECT count(*), sum(hash(t)) FROM read_parquet('{}') t"
            first = connection.execute(query.format(build / "tables" / f"{table}.parquet")).fetchone()
            second = connection.execute(query.format(again / "tables" / f"{table}.parquet")).fetchone()
            assert first == second, table
