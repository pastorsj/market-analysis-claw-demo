# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Pack validation and resolution, on the real market-analysis pack and broken copies of it."""

from __future__ import annotations

import pytest
from conftest import edit_yaml

from demo_data.pack import PackError
from demo_data.pack import declared_contract_errors
from demo_data.pack import find_contracts
from demo_data.pack import load_pack


def test_market_pack_is_valid_and_satisfies_the_market_analytics_contract(market_pack, contract):
    assert market_pack.id == "market-analysis"
    assert market_pack.database_tables == [
        "assets",
        "ticker_history",
        "trading_sessions",
        "daily_prices",
        "corporate_actions",
        "news_articles",
        "asset_relationships",
        "index_memberships",
    ]
    assert declared_contract_errors(market_pack, [contract]) == []


def test_market_pack_satisfies_every_tool_contract_in_the_repository(market_pack):
    contracts = find_contracts()
    if not contracts:
        pytest.skip("no tools/*/contract/*.json in this checkout")
    assert declared_contract_errors(market_pack, contracts) == []


def test_a_broken_pack_reports_every_problem(pack_copy):
    pack_dir = pack_copy()

    def break_it(manifest):
        manifest["structured"]["database_name"] = "market"
        manifest["provenance"][0]["license"] = "MIT"
        manifest["documents"]["corpora"][1]["manifest"] = "corpus/missing.json"
        manifest["analytics"]["news_table"] = "news_feed"
        manifest["prediction"]["entity"]["table"] = "assets"

    def break_questions(document):
        for question in document["questions"]:
            question["featured"] = False
        document["questions"][0]["sources"] = ["market_prices"]

    edit_yaml(pack_dir / "pack.yaml", break_it)
    edit_yaml(pack_dir / "questions.yaml", break_questions)

    with pytest.raises(PackError) as raised:
        load_pack(pack_dir)

    assert sorted(raised.value.errors) == sorted(
        [
            "structured.database_name must be 'market_analysis' (the pack id in snake_case)",
            "origin synthetic-market-generator: unknown license 'MIT'",
            "corpus market_regulations: manifest corpus/missing.json not found",
            "analytics.news_table 'news_feed' is not a table",
            "prediction.entity.table must be one of prediction.tables",
            "question market-leaders: unknown source 'market_prices'",
            "at least one question must be featured",
        ]
    )


def test_schema_errors_name_the_offending_field(pack_copy):
    pack_dir = pack_copy()
    edit_yaml(
        pack_dir / "pack.yaml", lambda m: m["prediction"]["population"].update(ids=[f"a{i}" for i in range(1001)])
    )

    with pytest.raises(PackError) as raised:
        load_pack(pack_dir)

    assert len(raised.value.errors) == 1
    assert raised.value.errors[0].startswith("pack.yaml: prediction/population/ids: ")


def test_resolve_serves_only_what_the_build_contains(market_pack):
    corpora = market_pack.select_corpora(["market_regulations"])
    resolved = market_pack.resolve("interactive", corpora)

    assert [source["id"] for source in resolved["sources"]] == ["market_analysis_structured", "market_regulations"]
    questions = [question["id"] for question in resolved["questions"]]
    assert "market-regulations-cybersecurity" in questions
    assert "market-news-cybersecurity-disclosures" not in questions  # needs market_news, which is not built
    assert "market-qualification-universe-scan" not in questions  # qualification profile only
    assert list(resolved["analytics"]["universes"]) == ["reviewed_assets"]
    assert resolved["analytics"]["relationship_graph"]["mode"] == "full_correlation"
    assert resolved["structured"]["database"] == "structured/market_analysis.duckdb"
    assert resolved["documents"] == {
        "collection": "aiq_market_intelligence_current",
        "sources": ["market_regulations"],
        "path": "corpus/documents.jsonl",
    }


def test_default_corpora_include_the_briefs(market_pack):
    sources = [corpus["source"] for corpus in market_pack.select_corpora(None)]
    assert sources == ["market_news", "market_regulations", "market_briefs"]
    with pytest.raises(PackError, match="no corpus for"):
        market_pack.select_corpora(["market_prices"])


def test_default_corpora_skip_opt_in_ones(pack_copy):
    pack_dir = pack_copy()
    edit_yaml(pack_dir / "pack.yaml", lambda m: m["documents"]["corpora"][2].update(opt_in=True))
    pack = load_pack(pack_dir)

    assert [corpus["source"] for corpus in pack.select_corpora(None)] == ["market_news", "market_regulations"]
    assert [corpus["source"] for corpus in pack.select_corpora(["market_briefs"])] == ["market_briefs"]


def test_profiles(market_pack):
    assert market_pack.resolve_profile(None) == "qualification"
    assert market_pack.resolve_profile("interactive") == "interactive"
    with pytest.raises(PackError, match="unknown profile"):
        market_pack.resolve_profile("huge")


def test_digest_tracks_build_inputs_only(pack_copy):
    pack = load_pack(pack_copy())
    corpora = pack.select_corpora(None)
    digest = pack.digest("interactive", corpora, "builder")

    assert pack.digest("interactive", corpora, "builder") == digest
    assert pack.digest("qualification", corpora, "builder") != digest
    assert pack.digest("interactive", corpora[:1], "builder") != digest
    assert pack.digest("interactive", corpora, "another builder") != digest
    (pack.directory / "README.md").write_text("data card")
    (pack.directory / "eval" / "notes.md").write_text("not an input")
    assert pack.digest("interactive", corpora, "builder") == digest
    (pack.directory / "ontology.yaml").write_text(pack.path("ontology.yaml").read_text() + "\n")
    assert pack.digest("interactive", corpora, "builder") != digest
