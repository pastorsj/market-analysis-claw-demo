# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Skills lint: the Agent Skills spec, Hermes' skill index budget, and tool names."""

from pathlib import Path

import pytest
import skills_ref
from common import MCP_TOOL
from common import SKILL_DIRS
from common import exposed_tools

HERMES_INDEX_LIMIT = 60  # SKILL_PROMPT_DESC_LIMIT: Hermes truncates longer descriptions in the skill index


def test_skills_exist():
    assert SKILL_DIRS


@pytest.mark.parametrize("skill_dir", SKILL_DIRS, ids=lambda path: path.name)
def test_skill_follows_the_agent_skills_spec(skill_dir: Path):
    assert skills_ref.validate(skill_dir) == []


@pytest.mark.parametrize("skill_dir", SKILL_DIRS, ids=lambda path: path.name)
def test_description_fits_the_hermes_skill_index(skill_dir: Path):
    description = skills_ref.read_properties(skill_dir).description
    assert len(description) <= HERMES_INDEX_LIMIT, f"{len(description)} chars; put the trigger words first"


@pytest.mark.parametrize("skill_dir", SKILL_DIRS, ids=lambda path: path.name)
def test_named_tools_are_exposed_by_the_config(skill_dir: Path, config: dict):
    named = {match.group(0) for match in MCP_TOOL.finditer((skill_dir / "SKILL.md").read_text(encoding="utf-8"))}
    assert named <= exposed_tools(config)
