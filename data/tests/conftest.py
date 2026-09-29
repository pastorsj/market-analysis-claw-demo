# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest
import yaml

from demo_data.pack import DATA_ROOT
from demo_data.pack import Pack
from demo_data.pack import load_pack

PACKS = DATA_ROOT / "packs"
FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def market_pack() -> Pack:
    return load_pack(PACKS / "market-analysis")


@pytest.fixture(scope="session")
def contract() -> dict[str, Any]:
    """The market-analytics/v1 contract as the data-pack design describes it (a local copy; tools own the real one)."""
    return json.loads((FIXTURES / "contracts" / "market-analytics.v1.json").read_text())


@pytest.fixture
def pack_copy(tmp_path: Path):
    """A function that copies a pack into tmp_path/packs and returns the copy's directory."""

    def copy(name: str = "market-analysis", source: Path = PACKS) -> Path:
        target = tmp_path / "packs" / name
        shutil.copytree(source / name, target, ignore=shutil.ignore_patterns("__pycache__"))
        return target

    return copy


def edit_yaml(path: Path, edit) -> None:
    document = yaml.safe_load(path.read_text())
    edit(document)
    path.write_text(yaml.safe_dump(document, sort_keys=False))
