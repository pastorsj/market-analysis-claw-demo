# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Partition-scoped, batched minute-bar scans in both layouts."""

from datetime import datetime
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
import pytest
from fixture_bars import minute_bars
from fixture_bars import month_partitions
from fixture_bars import per_symbol

from market_analytics.bars import MinuteBars
from market_analytics.bars import session_bars

# June 30, 2026 in UTC, the worker's timestamp model: 04:00 June 30 to 03:59 July 1 in New York (EDT, UTC-4).
JUNE_30 = (datetime(2026, 6, 30, 4, 0), datetime(2026, 7, 1, 3, 59))
EVERYTHING = (datetime(2026, 6, 1), datetime(2026, 7, 31))


@pytest.fixture(scope="module", params=["per_symbol", "month_partitions"])
def bars(request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory) -> MinuteBars:
    layout = {"per_symbol": per_symbol, "month_partitions": month_partitions}[request.param]
    return MinuteBars.from_pack({"market": {"bars": layout(tmp_path_factory.mktemp(request.param))}})


def expected_sessions(symbols: list[str], day: str) -> pd.DataFrame:
    """The regular session's bars (09:30 to 16:00, both included) reduced by hand."""
    frame = minute_bars()
    frame = frame[
        frame["symbol"].isin(symbols)
        & (frame["ts"].dt.strftime("%Y-%m-%d") == day)
        & frame["ts"].dt.strftime("%H:%M").between("09:30", "16:00")
    ]
    return frame.groupby("symbol", as_index=False).agg(
        open=("open", "first"), close=("close", "last"), volume=("volume", "sum"), bar_count=("close", "count")
    )


def test_a_scan_reduces_the_regular_session_of_the_named_symbols(bars: MinuteBars) -> None:
    scan = bars.scan(["CCC", "AAA"], *JUNE_30, session_bars)

    assert scan.rows == 2 * 391
    result = scan.result
    assert result["session"].tolist() == [pd.Timestamp("2026-06-30")] * 2
    expected = expected_sessions(["AAA", "CCC"], "2026-06-30")
    pd.testing.assert_frame_equal(result[expected.columns.tolist()], expected)
    assert (result["high"] >= result[["open", "close"]].max(axis=1)).all()
    assert (result["vwap"].between(result["low"], result["high"])).all()


def test_only_the_named_symbols_files_and_the_windows_row_groups_are_read(tmp_path: Path) -> None:
    bars = MinuteBars.from_pack({"market": {"bars": per_symbol(tmp_path)}})
    start, end = (bars.local(moment) for moment in JUNE_30)

    parts = bars.plan(["CCC", "AAA", "ZZZ"], start, end)

    assert [(part.path.name, part.symbol) for part in parts] == [
        ("CCC_full_1min_adjsplit.parquet", "CCC"),
        ("AAA_full_1min_adjsplit.parquet", "AAA"),
    ]
    # Each file has one row group per day, and the window needs only the second.
    assert parts[0].bytes == pq.read_metadata(parts[0].path).row_group(1).total_byte_size


def test_month_partitions_are_pruned_by_window_and_parts_by_symbol(tmp_path: Path) -> None:
    bars = MinuteBars.from_pack({"market": {"bars": month_partitions(tmp_path)}})
    july = (datetime(2026, 7, 1), datetime(2026, 7, 1, 23, 59))

    parts = bars.plan(["CCC"], *july)

    assert [part.path.relative_to(tmp_path).as_posix() for part in parts] == ["bars/month=2026-07/part-001.parquet"]
    assert len(bars.plan(["AAA", "CCC"], *EVERYTHING)) == 4  # both months, both parts


def test_the_batch_budget_bounds_each_read_but_not_the_result(bars: MinuteBars) -> None:
    whole = bars.scan(["AAA", "BBB", "CCC"], *EVERYTHING, session_bars)
    batched = bars.scan(["AAA", "BBB", "CCC"], *EVERYTHING, session_bars, budget=1)

    assert whole.batches == 1
    assert batched.batches == batched.files > 1  # a file larger than the budget is a batch of its own
    pd.testing.assert_frame_equal(
        batched.result.sort_values(["symbol", "session"], ignore_index=True), whole.result, check_exact=True
    )
    assert len(whole.result) == 3 * 3  # every symbol and day


def test_the_window_is_converted_to_the_datasets_wall_clock(bars: MinuteBars) -> None:
    """13:30 UTC on June 30 is 09:30 in New York."""
    scan = bars.scan(["BBB"], datetime(2026, 6, 30, 13, 30), datetime(2026, 6, 30, 13, 34), lambda frame: frame)

    assert scan.result["time"].dt.strftime("%H:%M").tolist() == ["09:30", "09:31", "09:32", "09:33", "09:34"]
    assert set(scan.result["symbol"]) == {"BBB"}


def test_a_scan_that_matches_nothing_is_empty(bars: MinuteBars) -> None:
    scan = bars.scan(["AAA"], datetime(2026, 6, 30, 1, 0), datetime(2026, 6, 30, 2, 0), session_bars)  # overnight

    assert (scan.rows, len(scan.result)) == (0, 0)
    assert bars.scan(["ZZZ"], *EVERYTHING, session_bars).files == 0


def test_packs_without_minute_bars_have_none(tmp_path: Path) -> None:
    daily = {**per_symbol(tmp_path), "frequency": "1d"}

    assert MinuteBars.from_pack({}) is None
    assert MinuteBars.from_pack({"market": {"bars": daily}}) is None
