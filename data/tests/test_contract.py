# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Checking tables against a tool contract."""

from __future__ import annotations

import duckdb
import pytest

from demo_data.pack import contract_errors


@pytest.fixture
def connection(market_pack):
    """The market pack's declared tables (empty), plus a news table to fill per test."""
    with duckdb.connect() as connection:
        connection.execute(market_pack.path("schema.sql").read_text())
        connection.execute(
            """CREATE TABLE market_news (news_id VARCHAR, primary_asset_id VARCHAR, published_at TIMESTAMPTZ,
               source_name VARCHAR, sentiment_label VARCHAR, alignment_session_number BIGINT)"""
        )
        yield connection


def relations(pack) -> dict[str, str]:
    return {table: f"main.{table}" for table in pack.tables}


def test_declared_tables_satisfy_the_contract(market_pack, contract, connection):
    assert contract_errors(contract, market_pack, connection, relations(market_pack)) == []


def test_type_and_column_problems(market_pack, contract, connection):
    connection.execute("ALTER TABLE market_news ALTER published_at TYPE VARCHAR")
    connection.execute("ALTER TABLE market_news DROP COLUMN source_name")

    assert contract_errors(contract, market_pack, connection, relations(market_pack)) == [
        "market-analytics/v1: market_news.published_at is VARCHAR, not timestamp",
        "market-analytics/v1: market_news.source_name is missing",
    ]


def test_row_rules_apply_once_tables_have_rows(market_pack, contract, connection):
    connection.execute(
        """INSERT INTO market_news VALUES
           ('n1', 'a', '2026-08-18 21:30:00+00', 'Wire', 'bullish', 2),
           ('n1', 'a', '2026-08-19 21:30:00+00', 'Wire', 'neutral', 3)"""
    )
    contract = contract | {"tables": {"$news_table": contract["tables"]["$news_table"] | {"unique": [["news_id"]]}}}

    assert contract_errors(contract, market_pack, connection, relations(market_pack)) == [
        "market-analytics/v1: market_news.sentiment_label has 1 rows outside ['positive', 'neutral', 'negative']",
        "market-analytics/v1: market_news has 1 duplicate ('news_id',) keys",
    ]


def test_a_missing_table_and_the_contracts_own_type_names(market_pack, connection):
    contract = {
        "id": "prices/v1",
        "logical_types": {"number": ["DOUBLE"]},
        "tables": {"daily_prices": {"columns": {"adjusted_close": "number"}}, "fx_rates": {"columns": {}}},
    }

    assert contract_errors(contract, market_pack, connection, relations(market_pack)) == [
        "prices/v1: table fx_rates is missing"
    ]


def test_a_table_without_rows_yet_is_only_checked_for_presence(market_pack, contract, connection):
    without_news = {table: relation for table, relation in relations(market_pack).items() if table != "market_news"}

    assert contract_errors(contract, market_pack, connection, without_news) == []
