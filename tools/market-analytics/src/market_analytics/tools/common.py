# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""What every market tool returns, plus two small helpers they share."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC
from datetime import datetime

import pandas as pd
from pydantic import BaseModel

from ..models import Frequency
from ..models import InvalidRequest


@dataclass(frozen=True)
class Output:
    payload: BaseModel
    rows_scanned: int
    assets: int  # distinct assets in the rows scanned
    empty: bool = False
    warnings: tuple[str, ...] = ()


NANOSECONDS_PER_DAY = 86_400_000_000_000


def check_window(start: datetime, end: datetime) -> None:
    """Both ends are naive UTC here (tools/__init__.py converts the arguments); the message shows them as UTC."""
    if end < start:
        end_text, start_text = (moment.replace(tzinfo=UTC).isoformat() for moment in (end, start))
        raise InvalidRequest(f"the window ends ({end_text}) before it starts ({start_text})")


def period_start(timestamps: pd.Series, frequency: Frequency) -> pd.Series:
    """Midnight UTC of the day, the Monday of the week, or the first of the month that holds each timestamp."""
    day = timestamps.dt.floor("D")
    if frequency == "weekly":
        return day - _days(day.dt.dayofweek)
    if frequency == "monthly":
        return day - _days(day.dt.day - 1)
    return day


def _days(counts: pd.Series) -> pd.Series:
    # Integer nanoseconds cast to a timedelta: runs on the GPU, where pd.to_timedelta falls back to pandas.
    return (counts.astype("int64") * NANOSECONDS_PER_DAY).astype("timedelta64[ns]")
