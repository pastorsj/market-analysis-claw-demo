-- SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
-- SPDX-License-Identifier: Apache-2.0
--
-- Physical schema of the market_analysis DuckDB. demo-data runs this, then loads each table with
-- INSERT INTO main.<table> BY NAME SELECT * FROM read_parquet('tables/<table>.parquet').
-- Primary and foreign keys here are also the keys of the Auto Ontology model.
CREATE TABLE main.assets (
  asset_id VARCHAR PRIMARY KEY, company_name VARCHAR NOT NULL, sector VARCHAR NOT NULL,
  industry VARCHAR NOT NULL, exchange VARCHAR NOT NULL, currency VARCHAR NOT NULL,
  region VARCHAR NOT NULL, active_from DATE NOT NULL, active_to DATE,
  is_reviewed BOOLEAN NOT NULL
);
CREATE TABLE main.ticker_history (
  ticker_history_id VARCHAR PRIMARY KEY,
  asset_id VARCHAR NOT NULL REFERENCES main.assets(asset_id), ticker VARCHAR NOT NULL,
  effective_from DATE NOT NULL, effective_to DATE
);
CREATE TABLE main.trading_sessions (
  session_id VARCHAR PRIMARY KEY, exchange VARCHAR NOT NULL, trading_date DATE NOT NULL,
  session_status VARCHAR NOT NULL, close_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE main.daily_prices (
  price_id VARCHAR PRIMARY KEY, asset_id VARCHAR NOT NULL REFERENCES main.assets(asset_id),
  trading_date DATE NOT NULL, exchange VARCHAR NOT NULL, raw_open DOUBLE NOT NULL,
  raw_high DOUBLE NOT NULL, raw_low DOUBLE NOT NULL, raw_close DOUBLE NOT NULL,
  adjusted_close DOUBLE NOT NULL, volume BIGINT NOT NULL, cumulative_split_factor DOUBLE NOT NULL,
  dividend_amount_usd DOUBLE NOT NULL, total_return_1d DOUBLE NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL, UNIQUE(asset_id, trading_date)
);
CREATE TABLE main.corporate_actions (
  action_id VARCHAR PRIMARY KEY, asset_id VARCHAR NOT NULL REFERENCES main.assets(asset_id),
  effective_date DATE NOT NULL, action_type VARCHAR NOT NULL, split_ratio DOUBLE NOT NULL,
  cash_amount_usd DOUBLE NOT NULL
);
CREATE TABLE main.news_articles (
  article_id VARCHAR PRIMARY KEY,
  primary_asset_id VARCHAR NOT NULL REFERENCES main.assets(asset_id), document_id VARCHAR NOT NULL,
  published_at TIMESTAMPTZ NOT NULL, ingested_at TIMESTAMPTZ NOT NULL,
  source_name VARCHAR NOT NULL, headline VARCHAR NOT NULL, event_type VARCHAR NOT NULL,
  sentiment_label VARCHAR NOT NULL
);
CREATE TABLE main.asset_relationships (
  relationship_id VARCHAR PRIMARY KEY,
  source_asset_id VARCHAR NOT NULL REFERENCES main.assets(asset_id),
  target_asset_id VARCHAR NOT NULL REFERENCES main.assets(asset_id), relationship_type VARCHAR NOT NULL,
  effective_from DATE NOT NULL, effective_to DATE
);
CREATE TABLE main.index_memberships (
  membership_id VARCHAR PRIMARY KEY, asset_id VARCHAR NOT NULL REFERENCES main.assets(asset_id),
  index_name VARCHAR NOT NULL, effective_from DATE NOT NULL, effective_to DATE,
  initial_weight DOUBLE NOT NULL
);
