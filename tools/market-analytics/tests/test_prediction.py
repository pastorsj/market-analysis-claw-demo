# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""predict_asset_outcomes around a stubbed Kumo client, plus one live call when an endpoint is configured."""

import os
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from fixture_pack import TEMPLATES
from mcp import Client
from mcp.server.mcpserver import MCPServer

from market_analytics import prediction
from market_analytics.data import Pack
from market_analytics.prediction import Horizon
from market_analytics.prediction import Predictor
from market_analytics.prediction import horizon
from market_analytics.prediction import register
from market_analytics.server import KumoConfigError
from market_analytics.server import kumo_endpoint
from market_analytics.server import register_kumo

pytestmark = pytest.mark.anyio


class StubClient:
    """Records what predict_asset_outcomes sends and answers like RelationalClient for a binary query."""

    calls: list[dict[str, Any]] = []
    error: Exception | None = None

    def __init__(self, url: str, api_key: str | None = None, **options: Any) -> None:
        self.call = {"url": url, "api_key": api_key, **options}

    def __enter__(self) -> "StubClient":
        return self

    def __exit__(self, *_: object) -> None:
        pass

    def relational(self, graph: Any) -> "StubClient":
        self.call["graph"] = graph
        return self

    def predict(self, query: str, indices: list[str], **options: Any) -> pd.DataFrame:
        self.calls.append({**self.call, "query": query, "indices": indices, **options})
        if self.error is not None:
            raise self.error
        probabilities = [0.25 + 0.25 * position for position in range(len(indices))]
        return pd.DataFrame(
            {"ENTITY": indices, "PREDICTION": [p > 0.5 for p in probabilities], "TRUE_PROB": probabilities}
        )


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def stub(monkeypatch: pytest.MonkeyPatch) -> type[StubClient]:
    monkeypatch.setattr(StubClient, "calls", [])
    monkeypatch.setattr(StubClient, "error", None)
    monkeypatch.setattr(prediction, "RelationalClient", StubClient)
    return StubClient


def server_with_prediction(pack: Pack) -> MCPServer:
    server = MCPServer("market_analytics")
    register(server, pack, "https://kumo.example.com", api_key="dummy-key")
    return server


URL = "https://kumo.example.com"
KEY = "k" * 64


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({"KUMO_RELATIONAL_URL": URL, "KUMO_API_KEY": KEY}, (URL, KEY)),
        ({"KUMO_RELATIONAL_URL": f" {URL} ", "KUMO_API_KEY": f"{KEY}\n"}, (URL, KEY)),
        ({}, None),
        ({"KUMO_RELATIONAL_URL": "", "KUMO_API_KEY": ""}, None),  # Compose renders an unset variable as ""
    ],
)
def test_kumo_is_on_with_its_url_and_key_and_off_with_neither(
    env: dict[str, str], expected: tuple[str, str] | None, tmp_path: Path
) -> None:
    assert kumo_endpoint(env, secret=tmp_path / "absent") == expected


@pytest.mark.parametrize(
    ("env", "missing"),
    [({"KUMO_RELATIONAL_URL": URL}, "KUMO_API_KEY is empty"), ({"KUMO_API_KEY": KEY}, "KUMO_RELATIONAL_URL is empty")],
)
def test_a_url_without_a_key_or_a_key_without_a_url_is_refused(
    env: dict[str, str], missing: str, tmp_path: Path
) -> None:
    with pytest.raises(KumoConfigError, match=f"both KUMO_RELATIONAL_URL and KUMO_API_KEY, and {missing}"):
        kumo_endpoint(env, secret=tmp_path / "absent")


def test_the_key_comes_from_the_compose_secret(tmp_path: Path) -> None:
    secret = tmp_path / "kumo_api_key"
    secret.write_text(f"{KEY}\n")
    assert kumo_endpoint({"KUMO_RELATIONAL_URL": URL}, secret=secret) == (URL, KEY)
    with pytest.raises(KumoConfigError, match="KUMO_RELATIONAL_URL is empty"):
        kumo_endpoint({}, secret=secret)  # a key with no URL


@pytest.mark.parametrize(
    ("env", "registered"),
    [
        ({"KUMO_RELATIONAL_URL": URL, "KUMO_API_KEY": KEY}, True),
        ({}, False),
    ],
)
async def test_the_tool_is_registered_only_with_both_url_and_key(
    pack: Pack, env: dict[str, str], registered: bool, tmp_path: Path, stub: type[StubClient]
) -> None:
    server = MCPServer("market_analytics")
    assert register_kumo(server, pack, kumo_endpoint(env, secret=tmp_path / "absent")) is registered
    async with Client(server) as client:
        names = {tool.name for tool in (await client.list_tools()).tools}
        assert ("predict_asset_outcomes" in names) is registered
        if registered:
            await client.call_tool("predict_asset_outcomes", {"template_id": "positive_return"})
    if registered:
        (call,) = stub.calls
        assert (call["url"], call["api_key"]) == (URL, KEY)  # the client sends the key as X-API-Key


def test_horizon_is_read_from_the_pql_window() -> None:
    assert horizon(TEMPLATES[0]["pql"]) == Horizon(value=5, unit="days")
    assert horizon("PREDICT SUM(orders.price, -2, 30, Days) FOR users.user_id=1") == Horizon(value=32, unit="days")
    with pytest.raises(ValueError, match="no aggregation window"):
        horizon("PREDICT users.age FOR users.user_id=1")


async def test_the_tool_offers_only_the_pack_templates(pack: Pack) -> None:
    async with Client(server_with_prediction(pack)) as client:
        tool = next(tool for tool in (await client.list_tools()).tools if tool.name == "predict_asset_outcomes")

    assert tool.annotations.read_only_hint
    assert tool.input_schema["properties"]["template_id"]["enum"] == ["positive_return", "any_price"]
    assert set(tool.input_schema["properties"]) == {"template_id", "asset_ids", "source_ids"}
    assert tool.input_schema["required"] == ["template_id"]


async def test_prediction_maps_kumo_rows_to_asset_probabilities(pack: Pack, stub: type[StubClient]) -> None:
    async with Client(server_with_prediction(pack)) as client:
        result = await client.call_tool("predict_asset_outcomes", {"template_id": "positive_return"})

    assert result.structured_content == {
        "available": True,
        "reason": None,
        "template_id": "positive_return",
        "pql": TEMPLATES[0]["pql"],
        "anchor": pack.prediction["anchor"],
        "horizon": {"value": 5, "unit": "days"},
        "rows": [
            {"asset_id": "asset-alpha", "probability": 0.25},
            {"asset_id": "asset-beta", "probability": 0.5},
            {"asset_id": "asset-gamma", "probability": 0.75},
        ],
        "model": "kumo-relational",
    }
    (call,) = stub.calls
    assert (call["url"], call["api_key"]) == ("https://kumo.example.com", "dummy-key")
    assert (call["max_retries"], call["num_retries"]) == (0, 0)  # one attempt, so the call ends within its timeout
    assert call["query"] == TEMPLATES[0]["pql"]
    assert call["anchor_time"] == pd.Timestamp(pack.prediction["anchor"])
    assert call["run_mode"] == "fast"


def test_the_graph_has_the_pack_keys_time_columns_and_links(pack: Pack) -> None:
    graph = Predictor(pack, "https://kumo.example.com").graph()

    assert graph["price_events"].primary_key.name == "price_id"
    assert graph["return_outcomes"].time_column.name == "realized_at"
    assert sorted((edge.src_table, edge.fkey, edge.dst_table) for edge in graph.edges) == [
        ("price_events", "asset_id", "asset_entities"),
        ("return_outcomes", "asset_id", "asset_entities"),
    ]
    graph.validate()


async def test_an_unreachable_endpoint_makes_the_prediction_unavailable(pack: Pack, stub: type[StubClient]) -> None:
    stub.error = ConnectionError("connection refused")
    async with Client(server_with_prediction(pack)) as client:
        result = await client.call_tool(
            "predict_asset_outcomes", {"template_id": "any_price", "asset_ids": ["asset-beta"]}
        )

    content = result.structured_content
    assert (content["available"], content["reason"], content["rows"]) == (
        False,
        "ConnectionError: connection refused",
        [],
    )
    assert content["horizon"] == {"value": 7, "unit": "days"}
    assert stub.calls[0]["indices"] == ["asset-beta"]


async def test_assets_outside_the_population_and_unselected_sources_are_refused(
    pack: Pack, stub: type[StubClient]
) -> None:
    async with Client(server_with_prediction(pack)) as client:
        outside = await client.call_tool(
            "predict_asset_outcomes", {"template_id": "any_price", "asset_ids": ["asset-omega"]}
        )
        unselected = await client.call_tool(
            "predict_asset_outcomes", {"template_id": "any_price", "source_ids": ["market_news"]}
        )

    assert outside.is_error
    assert "no predictions for ['asset-omega']" in outside.content[0].text
    assert unselected.structured_content["available"] is False
    assert stub.calls == []


@pytest.mark.live
def test_live_prediction() -> None:
    """KUMO_RELATIONAL_URL and KUMO_API_KEY (a Kumo Relational service) plus DATA_ACTIVE_DIR with a real pack."""
    if not (
        os.environ.get("KUMO_RELATIONAL_URL") and os.environ.get("KUMO_API_KEY") and os.environ.get("DATA_ACTIVE_DIR")
    ):
        pytest.skip("set KUMO_RELATIONAL_URL, KUMO_API_KEY and DATA_ACTIVE_DIR")
    pack = Pack.load(Path(os.environ["DATA_ACTIVE_DIR"]))
    predictor = Predictor(pack, os.environ["KUMO_RELATIONAL_URL"], os.environ["KUMO_API_KEY"])
    template_id = next(iter(predictor.templates))

    result = predictor.predict(template_id, predictor.population[:2])

    assert result.available, result.reason
    assert [row.asset_id for row in result.rows] == predictor.population[:2]
    assert all(0 <= row.probability <= 1 for row in result.rows)
