# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Every pack's eval files follow their format and agree with the pack, the registry and the guard's margin rule."""

import json
import re
from pathlib import Path

import pytest
import yaml
from support import REPO

from demo_eval import facts
from demo_eval.spec import FACT
from demo_eval.spec import SpecError
from demo_eval.spec import floor_for
from demo_eval.spec import load_answers
from demo_eval.spec import load_perf

PACKS = sorted(path for path in (REPO / "data" / "packs").iterdir() if (path / "pack.yaml").is_file())
TOOLS = {tool["id"]: tool for tool in json.loads((REPO / "contracts" / "tool-registry.json").read_text())["tools"]}
# tools/retrieval/src/demo_retrieval/benchmark.py PROFILES
MILVUS_PROFILES = {"vector-single", "vector-batch", "vector-concurrency"}


def questions(pack: Path) -> dict[str, dict]:
    return {q["id"]: q for q in yaml.safe_load((pack / "questions.yaml").read_text())["questions"]}


@pytest.mark.parametrize("pack", PACKS, ids=lambda pack: pack.name)
def test_the_answer_checks_name_real_questions_tools_and_oracle_columns(pack):
    spec = load_answers(pack)
    offered = questions(pack)
    assert spec.questions, f"{pack.name} has no eval/answers.yaml"
    for qid, question in spec.questions.items():
        assert qid in offered, f"{pack.name}: answers.yaml checks {qid}, which questions.yaml lacks"
        for group in question.tools:
            assert group <= set(TOOLS), f"{pack.name}/{qid}: unknown tools {sorted(group - set(TOOLS))}"
        # The question's declared pills come from tools its checks require
        required = {pill for group in question.tools for tool in group for pill in TOOLS[tool]["pills"]}
        assert set(offered[qid].get("tools") or []) & required or not question.tools, qid
        # Each referenced column is one the oracle's SQL selects
        for check in question.checks:
            if check.kind in ("named", "percent"):
                oracle, field = re.match(r"(\w+)\[.*\]\.(\w+)", check.value).groups()
                sql = next(o.sql for o in question.oracles if o.name == oracle)
                assert re.search(rf"\b{field}\b", (pack / "eval" / "oracles" / f"{sql}.sql").read_text()), (
                    f"{pack.name}/{qid}: {sql}.sql has no column {field}"
                )


@pytest.mark.parametrize("pack", PACKS, ids=lambda pack: pack.name)
def test_the_facts_render_every_placeholder(pack):
    spec = load_answers(pack)
    for question in spec.questions.values():
        assert question.facts, f"{pack.name}/{question.id} has no reference facts for the grader"
        placeholders = list(FACT.finditer(question.facts))
        fields = {name.strip() for match in placeholders for name in match["fields"].split(",")}
        rows = {o.name: [dict.fromkeys(fields, 0.1)] * 25 for o in question.oracles}
        rendered = facts.render(spec, question, rows)
        assert not FACT.search(rendered), question.id
        for field in fields:
            assert f"{field}=" in rendered, f"{pack.name}/{question.id}: {field} did not render"


@pytest.mark.parametrize("pack", PACKS, ids=lambda pack: pack.name)
def test_the_gpu_guard_cases_are_market_tools_with_floors_at_half_the_lowest_recorded_speedup(pack):
    spec = load_perf(pack)
    assert spec is not None, f"{pack.name} has no eval/perf.yaml"
    generator = (yaml.safe_load((pack / "pack.yaml").read_text()).get("generator") or {}).get("profiles") or {}
    assert spec.profile in generator or spec.profile == "default", spec.profile
    for case in spec.market:
        assert TOOLS[case.tool]["family"] == "market_analytics", case.id
        assert case.recorded, f"{case.id} records no A100 speedup"
        if case.min_speedup is not None:
            assert case.min_speedup == floor_for(case.recorded), case.id
    assert {case.profile_id for case in spec.retrieval} == MILVUS_PROFILES
    for case in spec.retrieval:
        assert case.min_speedup == floor_for(case.recorded), case.profile_id


def test_the_floor_is_half_the_lowest_speedup_rounded_down_to_a_twentieth():
    assert floor_for((3.0, 3.96)) == 1.5
    assert floor_for((4.23,)) == 2.1
    assert floor_for((1.16, 2.5)) == 0.55
    assert floor_for((1.07, 1.76)) == 0.5


def _pack(tmp_path: Path, answers: str) -> Path:
    (tmp_path / "eval" / "oracles").mkdir(parents=True)
    (tmp_path / "eval" / "oracles" / "leaders.sql").write_text("SELECT 1 AS asset_id")
    (tmp_path / "eval" / "answers.yaml").write_text(answers)
    return tmp_path


@pytest.mark.parametrize(
    ("answers", "message"),
    [
        ("questions: {q: {oracles: {x: {}}}}", "no eval/oracles/x.sql"),
        ("questions: {q: {oracles: {leaders: {limit: 500}}}}", "limit must be 1 to 100"),
        ("questions: {q: {checks: [{id: a, named: 'leaders[0].asset_id'}]}}", "names oracle leaders"),
        ("questions: {q: {checks: [{id: a, pattern: '('}]}}", "bad pattern"),
        ("questions: {q: {checks: [{id: a}]}}", "exactly one of"),
        ("questions: {q: {checks: [{id: a, pattern: x}, {id: a, pattern: y}]}}", "check ids repeat"),
        ("questions: {q: {tools: [market_scan]}}", "tools is a list"),
        ("questions: {q: {facts: '{leaders: asset_id}'}}", "facts name oracle leaders"),
        ("questions: {q: {colour: red}}", "unknown key"),
        (
            "questions: {q: {oracles: {leaders: {}}}, r: {oracles: {leaders: {limit: 5}}}}",
            "oracle leaders is defined differently",
        ),
    ],
)
def test_a_malformed_answers_file_is_refused_with_its_entry(tmp_path, answers, message):
    with pytest.raises(SpecError, match=re.escape(message)):
        load_answers(_pack(tmp_path, answers))


def test_a_pack_without_eval_files_gets_only_the_generic_checks(tmp_path):
    assert load_answers(tmp_path).questions == {}
    assert load_perf(tmp_path) is None
