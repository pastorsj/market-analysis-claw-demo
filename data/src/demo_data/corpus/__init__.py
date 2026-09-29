# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Build the corpus part of a pack: corpus/documents.jsonl, one whole document per line.

Each corpus `format` in pack.yaml names a builder, `documents(source_id, manifest_path, downloads)`, that turns
a pinned source into Document rows. Chunking and embedding belong to retrieval ingestion.
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from demo_data.corpus import briefs
from demo_data.corpus import ecfr
from demo_data.corpus import edgar
from demo_data.corpus.common import CorpusError
from demo_data.corpus.common import Document
from demo_data.corpus.common import Downloads
from demo_data.pack import SCHEMAS
from demo_data.pack import Pack

Builder = Callable[[str, Path, Downloads], list[Document]]
BUILDERS: dict[str, Builder] = {
    "ecfr-xml": ecfr.documents,
    "edgar-filings": edgar.documents,
    "markdown": briefs.documents,
}


def build(pack: Pack, corpora: list[dict[str, Any]], downloads: Downloads, out: Path) -> dict[str, int]:
    """Write out/corpus/documents.jsonl for `corpora`; returns the document count per source."""
    documents: list[Document] = []
    for corpus in corpora:
        documents += BUILDERS[corpus["format"]](corpus["source"], pack.path(corpus["manifest"]), downloads)
    documents.sort(key=lambda document: (document.source_id, document.document_id))
    rows = [asdict(document) for document in documents]
    errors = document_errors(rows)
    if errors:
        raise CorpusError("; ".join(errors[:5]))
    path = out / "corpus" / "documents.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    return dict(Counter(document.source_id for document in documents))


def document_errors(rows: list[dict[str, Any]]) -> list[str]:
    """Rows that break schemas/documents.schema.json, plus duplicate document ids."""
    validator = Draft202012Validator(json.loads((SCHEMAS / "documents.schema.json").read_text(encoding="utf-8")))
    errors = [
        f"{row.get('document_id')}: {'/'.join(map(str, error.absolute_path)) or '(root)'}: {error.message}"
        for row in rows
        for error in validator.iter_errors(row)
    ]
    counts = Counter(row["document_id"] for row in rows)
    return errors + [f"{document_id}: duplicate document_id" for document_id, count in counts.items() if count > 1]
