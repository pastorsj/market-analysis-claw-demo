# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Publishing the agent's draft: citations, the Sources list, and mechanical Markdown clean-up."""

from __future__ import annotations

from support import load_contract

from demo_api.reports.markdown import normalize_web_markdown
from demo_api.reports.publication import citations_from_receipts
from demo_api.reports.publication import publish_report

DIGEST = "6f6369003e7c34b6d766a3fea488d8113f41dcb6d9a1ecf0833ce2b5566d8433"


def test_citations_are_numbered_by_first_use_and_listed_once(tool_registry):
    evidence = citations_from_receipts(load_contract("receipts.json"), tool_registry)
    scan, retrieval = evidence[0].evidence_id, evidence[1].evidence_id
    draft = (
        f"Filings mention outages [evidence:{retrieval}]. Anomalies spiked [evidence:{scan}] "
        f"and again [evidence:{DIGEST}] [2].\n\n## Sources\n\n1. made up by the model"
    )

    report = publish_report(draft, evidence)

    assert report.markdown.splitlines()[0] == "Filings mention outages [1]. Anomalies spiked [2] and again [1]."
    assert report.markdown.endswith(
        f"## Sources\n\n- [1] Unstructured Retrieval evidence — 3 documents — evidence `{retrieval}`\n"
        f"- [2] Market analytics result — market anomaly scan — evidence `{scan}`"
    )
    assert [c["number"] for c in report.citations] == [1, 2]
    assert report.citations[1]["capabilityId"] == "market_analytics"
    assert report.invalid_evidence_ids == []


def test_lenticular_tokens_and_bracketed_receipt_ids_are_citations(tool_registry):
    evidence = citations_from_receipts(load_contract("receipts.json"), tool_registry)
    scan, retrieval = evidence[0].evidence_id, evidence[1].evidence_id
    draft = (
        f"Anomalies spiked【evidence:{scan}】 and filings agree 【evidence:{DIGEST}】. "
        f"Both again 【{scan}】 [{retrieval}], but not hermes-receipt:{DIGEST} unbracketed."
    )

    report = publish_report(draft, evidence)

    assert report.markdown.splitlines()[0] == (
        f"Anomalies spiked[1] and filings agree [2]. Both again [1] [2], but not hermes-receipt:{DIGEST} unbracketed."
    )
    assert [c["evidenceId"] for c in report.citations] == [scan, retrieval]
    assert report.invalid_evidence_ids == []


def test_unknown_evidence_is_removed_and_flagged(tool_registry):
    report = publish_report("A claim [evidence:hermes-receipt:unknown].", [])

    assert report.markdown.startswith("A claim.\n\n## Evidence limitation")
    assert report.invalid_evidence_ids == ["hermes-receipt:unknown"]


def test_failed_receipts_cannot_be_cited(tool_registry):
    failed = [r for r in load_contract("receipts.json") if r["status"] == "failed"]
    assert citations_from_receipts(failed, tool_registry) == []


def test_credentials_in_a_draft_are_masked():
    report = publish_report("Use api_key=abc123 with Bearer abcdefghijkl here.", [])
    assert report.markdown == "Use api_key=[redacted] with Bearer [redacted] here."


def test_markdown_is_unwrapped_and_tables_get_blank_lines():
    draft = "~~~markdown\nIntro\n| a | b |\n| --- | --- |\n| 1 | 2 |\nAfter   \n\n\n\n```code\nkeep   \n```\n~~~"
    assert normalize_web_markdown(draft) == (
        "Intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter\n\n```code\nkeep   \n```"
    )
