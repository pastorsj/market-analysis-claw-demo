# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""What every market tool returns, plus two small helpers they share."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import pandas as pd
from pydantic import BaseModel

from ..models import Frequency
from ..models import InvalidRequest


@dataclass(frozen=True)
class Output:
    payload: BaseModel
    rows_scanned: int
    empty: bool = False
    warnings: tuple[str, ...] = ()


def check_window(start: datetime, end: datetime) -> None:
    if end < start:
        raise InvalidRequest(f"the window ends ({end.isoformat()}) before it starts ({start.isoformat()})")


def period_start(timestamps: pd.Series, frequency: Frequency) -> pd.Series:
    """Midnight UTC of the day, the Monday of the week, or the first of the month that holds each timestamp."""
    day = timestamps.dt.normalize()
    if frequency == "weekly":
        return day - pd.to_timedelta(day.dt.dayofweek, unit="D")
    if frequency == "monthly":
        return day - pd.to_timedelta(day.dt.day - 1, unit="D")
    return day
