# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""retrieval-index: documents.jsonl -> chunks -> passage embeddings -> Milvus -> alias -> collection-manifest.json.

Each build gets its own collection, named by a fingerprint of the corpus and the embed configuration.
Re-running on unchanged input is a no-op. A changed input builds a new collection and moves the alias only
once it is complete, so the server answers from the previous build until then.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterator
from itertools import batched
from pathlib import Path
from typing import Any

from langchain_nvidia_ai_endpoints import NVIDIAEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pymilvus import MilvusClient

from . import nvidia
from . import store
from .datapack import DOCUMENTS
from .datapack import CollectionManifest
from .datapack import CorpusDocument
from .datapack import Pack
from .datapack import read_documents
from .settings import Settings

CHUNK_SIZE = 2400  # characters
CHUNK_OVERLAP = 240
EMBED_BATCH = 50  # texts per embeddings request

logger = logging.getLogger(__name__)
splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)


def run(settings: Settings, data_dir: Path) -> CollectionManifest:
    pack = Pack.load(data_dir)
    documents = read_documents(data_dir)
    source_ids = sorted({document.source_id for document in documents})
    if unknown := sorted(set(source_ids) - pack.document_sources):
        raise ValueError(f"documents.jsonl uses sources that pack.json does not declare as documents: {unknown}")
    rows = [row for document in documents for row in chunk(document)]
    collection = store.build_name(pack.collection, _fingerprint(data_dir, settings))

    client = MilvusClient(uri=settings.milvus_uri)
    try:
        if store.alias_target(client, pack.collection) == collection:
            logger.info("%s already serves this corpus; nothing to index", collection)
        else:
            build(client, collection, rows, nvidia.embedder(settings))
            store.point_alias(client, pack.collection, collection)
    finally:
        client.close()

    manifest = CollectionManifest(
        collection=pack.collection,
        physical_collection=collection,
        source_ids=source_ids,
        document_count=len(documents),
        chunk_count=len(rows),
        embed_model=settings.embed_model,
        index=store.INDEX,
    )
    manifest.write(data_dir)
    logger.info("%s -> %s: %d chunks of %d documents", pack.collection, collection, len(rows), len(documents))
    return manifest


def chunk(document: CorpusDocument) -> Iterator[dict[str, Any]]:
    for number, text in enumerate(splitter.split_text(document.text), start=1):
        yield {
            **document.metadata,
            "chunk_id": f"{document.document_id}:{number:04d}",
            "source_id": document.source_id,
            "document_id": document.document_id,
            "title": document.title,
            "url": document.url,
            "published_at": document.published_at,
            "text": text,
        }


def build(client: MilvusClient, collection: str, rows: list[dict[str, Any]], embedder: NVIDIAEmbeddings) -> None:
    if client.has_collection(collection):  # left over from an interrupted run
        client.drop_collection(collection)
    done = 0
    for number, batch in enumerate(batched(rows, EMBED_BATCH), start=1):
        vectors = _embed_passages(embedder, [row["text"] for row in batch])
        if number == 1:  # the first response tells us the embedding dimension
            store.create_collection(client, collection, dimension=len(vectors[0]))
        embedded = [{**row, store.VECTOR_FIELD: vector} for row, vector in zip(batch, vectors, strict=True)]
        client.insert(collection, embedded)
        done += len(batch)
        if number % 20 == 0 or done == len(rows):
            logger.info("indexed %d/%d chunks into %s", done, len(rows), collection)


@nvidia.retry_bulk
def _embed_passages(embedder: NVIDIAEmbeddings, texts: list[str]) -> list[list[float]]:
    return embedder.embed_documents(texts)  # input_type=passage


def _fingerprint(data_dir: Path, settings: Settings) -> str:
    """The corpus bytes plus everything that changes the vectors or the index."""
    digest = hashlib.sha256((data_dir / DOCUMENTS).read_bytes())
    config = [settings.base_url, settings.embed_model, CHUNK_SIZE, CHUNK_OVERLAP, store.INDEX]
    digest.update(json.dumps(config, sort_keys=True).encode())
    return digest.hexdigest()[:12]
