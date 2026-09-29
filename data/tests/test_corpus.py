# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Corpus builders on small offline fixtures (downloads are served from a pre-filled cache or a fake server)."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import shutil
from dataclasses import asdict
from pathlib import Path

import pytest
from conftest import FIXTURES

from demo_data import corpus
from demo_data.corpus import briefs
from demo_data.corpus import ecfr
from demo_data.corpus import edgar
from demo_data.corpus.common import CorpusError
from demo_data.corpus.common import Downloads


def cached(downloads: Downloads, fixture: Path) -> str:
    """Put a fixture in the download cache, as if fetched earlier; returns its sha256."""
    digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
    downloads.path(digest).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(fixture, downloads.path(digest))
    return digest


def write_manifest(path: Path, manifest: dict) -> Path:
    path.write_text(json.dumps(manifest))
    return path


def test_ecfr_one_document_per_section_with_its_headings(tmp_path):
    downloads = Downloads(tmp_path / "downloads")
    url = "https://www.ecfr.gov/api/versioner/v1/full/2026-08-17/title-17.xml"
    digest = cached(downloads, FIXTURES / "ecfr" / "title-17-mini.xml")
    manifest = write_manifest(
        tmp_path / "ecfr.json",
        {
            "source_id": "market_regulations",
            "as_of": "2026-08-17",
            "document": {
                "url": url,
                "sha256": digest,
                "title_number": "17",
                "title": "Title 17—Commodity and Securities Exchanges",
            },
        },
    )

    section, reserved = ecfr.documents("market_regulations", manifest, downloads)

    assert section.document_id.startswith("ecfr-title17:229.106:")
    assert section.title == "§ 229.106 (Item 106) Cybersecurity."
    assert section.url == "https://www.ecfr.gov/on/2026-08-17/title-17/section-229.106"
    assert section.text.split("\n\n")[:4] == [
        "Title 17—Commodity and Securities Exchanges",
        "CHAPTER II—SECURITIES AND EXCHANGE COMMISSION",
        "PART 229—STANDARD INSTRUCTIONS FOR FILING FORMS",
        "Subpart 229.100—Business",
    ]
    assert "cybersecurity incident means an unauthorized occurrence" in section.text
    assert section.metadata | {"snapshot_url": None} == {
        "citation": "17 CFR § 229.106",
        "title_number": "17",
        "chapter": "II",
        "chapter_heading": "CHAPTER II—SECURITIES AND EXCHANGE COMMISSION",
        "part": "229",
        "part_heading": "PART 229—STANDARD INSTRUCTIONS FOR FILING FORMS",
        "subpart_heading": "Subpart 229.100—Business",
        "section": "229.106",
        "as_of": "2026-08-17",
        "snapshot_url": None,
    }
    # A reserved range has no page of its own, so it links to its part.
    assert reserved.url == "https://www.ecfr.gov/on/2026-08-17/title-17/part-229"


def test_ecfr_rejects_another_title(tmp_path):
    with pytest.raises(CorpusError, match="not title 16"):
        ecfr.parse_title(
            FIXTURES / "ecfr" / "title-17-mini.xml",
            source_id="s",
            title_number="16",
            title_heading="Title 16",
            as_of="2026-08-17",
            snapshot_url="https://example.com",
        )


@pytest.fixture
def edgar_manifest(tmp_path) -> tuple[Path, Downloads]:
    downloads = Downloads(tmp_path / "downloads")
    filing = {
        "filing_id": "0000000001:0000000001-26-000001",
        "company_name": "EXAMPLE CORP",
        "form": "8-K",
        "filed_on": "2026-04-01",
        "source_url": "https://www.sec.gov/Archives/edgar/data/1/0000000001-26-000001.txt",
        "sha256": cached(downloads, FIXTURES / "edgar" / "submission.txt"),
    }
    return write_manifest(tmp_path / "edgar.json", {"source_id": "market_news", "filings": [filing]}), downloads


def test_edgar_keeps_the_primary_document_and_ex99_exhibits(edgar_manifest, monkeypatch):
    manifest, downloads = edgar_manifest
    monkeypatch.setenv("SEC_USER_AGENT", "Example Co admin@example.com")

    primary, exhibit = edgar.documents("market_news", manifest, downloads)

    assert primary.document_id == "edgar:0000000001:0000000001-26-000001:example-8k.htm"
    assert primary.title == "EXAMPLE CORP 8-K: CURRENT REPORT"
    assert primary.text.startswith("Item 1.05 Material Cybersecurity Incidents. On March 30, 2026")
    assert "track()" not in primary.text and "color" not in primary.text
    assert primary.published_at == "2026-04-01T00:00:00Z"
    assert primary.metadata["citation"] == "SEC 8-K, EXAMPLE CORP, filed 2026-04-01, accession 0000000001-26-000001"
    assert exhibit.metadata["document_type"] == "EX-99.1"
    assert exhibit.text.startswith("Example Corp announces that its operations were restored on April 1, 2026")


def test_edgar_text_keeps_no_control_characters():
    # PDF-extracted exhibits carry stray control characters, which the receipt schema refuses downstream.
    assert edgar.plain_text("Item\x031.05  Material\x7f\r\nIncidents\x00") == "Item 1.05 Material Incidents"


def test_edgar_needs_a_user_agent(edgar_manifest, monkeypatch):
    manifest, downloads = edgar_manifest
    monkeypatch.delenv("SEC_USER_AGENT", raising=False)

    with pytest.raises(CorpusError, match="SEC_USER_AGENT"):
        edgar.documents("market_news", manifest, downloads)


def test_briefs_become_documents_with_front_matter_as_metadata(market_pack):
    documents = briefs.documents("market_briefs", market_pack.path("documents/manifest.json"), None)

    assert len(documents) == 8
    aether = documents[0]
    assert aether.document_id == "aether-demand-update"  # joins main.news_articles.document_id
    assert aether.title == "Aether Raises Accelerated-Compute Demand Outlook"
    assert aether.published_at == "2026-08-18T13:30:00+00:00"
    assert aether.text.startswith("> **Synthetic market evidence.**")
    assert aether.metadata == {
        "citation": "Aether Raises Accelerated-Compute Demand Outlook",
        "document_type": "market_news",
        "synthetic": True,
        "article_id": "news-aether-demand-20260818",
        "asset_id": "asset-aether",
        "event_type": "guidance",
    }


def test_build_writes_sorted_valid_rows(market_pack, tmp_path):
    counts = corpus.build(market_pack, market_pack.select_corpora(["market_briefs"]), Downloads(tmp_path), tmp_path)

    rows = [json.loads(line) for line in (tmp_path / "corpus" / "documents.jsonl").read_text().splitlines()]
    assert counts == {"market_briefs": 8}
    assert [row["document_id"] for row in rows] == sorted(row["document_id"] for row in rows)
    assert list(rows[0]) == ["document_id", "source_id", "title", "text", "url", "published_at", "metadata"]


def test_document_rows_follow_the_schema(market_pack):
    row = asdict(briefs.documents("market_briefs", market_pack.path("documents/manifest.json"), None)[0])
    bad = [
        row | {"url": "http://example.com"},
        row | {"metadata": row["metadata"] | {"image": "chart.png"}},
        row | {"metadata": {"asset_id": "asset-aether"}},
    ]

    errors = corpus.document_errors([row, row, *bad])

    assert [error.split(": ")[1] for error in errors] == ["url", "metadata", "metadata", "duplicate document_id"]


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, encoding: str | None = None) -> None:
        super().__init__(body)
        self.headers = {"Content-Encoding": encoding} if encoding else {}


def test_downloads_are_checked_and_cached(tmp_path, monkeypatch):
    body = b"pinned content"
    digest = hashlib.sha256(body).hexdigest()
    requests = []

    def urlopen(request, timeout):
        requests.append(request.full_url)
        return FakeResponse(gzip.compress(body), "gzip")

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    downloads = Downloads(tmp_path)

    path = downloads.fetch("https://example.com/file", digest, user_agent="test", max_bytes=1000)
    assert path.read_bytes() == body
    assert downloads.fetch("https://example.com/file", digest, user_agent="test", max_bytes=1000) == path
    assert requests == ["https://example.com/file"]

    with pytest.raises(CorpusError, match="pinned"):
        downloads.fetch("https://example.com/other", "0" * 64, user_agent="test", max_bytes=1000)
    assert sorted(p.name for p in (tmp_path / "sha256").iterdir()) == [digest]
