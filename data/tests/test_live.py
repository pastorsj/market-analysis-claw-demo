# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""The pinned public sources are still served unchanged (network; run with `pytest -m live`)."""

from __future__ import annotations

import json
import os

import pytest

from demo_data.corpus import ecfr
from demo_data.corpus import edgar
from demo_data.corpus.common import Downloads

pytestmark = pytest.mark.live


def test_the_ecfr_snapshot_yields_every_section(market_pack, tmp_path):
    manifest = market_pack.path("corpus/ecfr-title17-2026-08-17.manifest.json")

    documents = ecfr.documents("market_regulations", manifest, Downloads(tmp_path))

    assert len(documents) == json.loads(manifest.read_text())["document"]["section_count"]


@pytest.mark.skipif(not os.environ.get("SEC_USER_AGENT"), reason="SEC EDGAR needs SEC_USER_AGENT")
def test_a_pinned_edgar_filing_is_unchanged(market_pack, tmp_path):
    manifest = json.loads(market_pack.path("corpus/sec-edgar-2026-q2.manifest.json").read_text())
    sample = tmp_path / "sample.json"
    sample.write_text(json.dumps(manifest | {"filings": manifest["filings"][:1]}))

    documents = edgar.documents("market_news", sample, Downloads(tmp_path))

    assert documents and documents[0].metadata["company_name"] == manifest["filings"][0]["company_name"]
