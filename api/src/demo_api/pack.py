# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""The active data pack, as the ``data`` one-shot built it under ``/data/active``.

``pack.json`` lists the pack's sources and questions. A source is offered to users only when the
running stack can serve it:

- its capabilities are narrowed to the tool families in the agent image (``AGENT_FEATURES``);
- a document source also needs the retrieval index, which ``retrieval-index`` records in
  ``collection-manifest.json``.

Files are read on every call, because ``/data/active`` is a symlink that a rebuild can switch.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .registry import ToolRegistry


class PackUnavailableError(Exception):
    """``/data/active/pack.json`` is missing or unreadable (the data one-shot has not run)."""


@dataclass(frozen=True, slots=True)
class Source:
    id: str
    name: str
    description: str
    agent_description: str
    kind: str
    capabilities: tuple[str, ...]
    synthetic: bool
    default_enabled: bool
    example_questions: tuple[str, ...]
    database_name: str | None

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "default_enabled": self.default_enabled,
            "kind": self.kind,
            "capabilities": list(self.capabilities),
            "synthetic": self.synthetic,
            "database_name": self.database_name,
        }

    def catalog_entry(self) -> dict[str, Any]:
        """How the agent sees this source in its run instructions."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.agent_description,
            "kind": self.kind,
            "capabilities": list(self.capabilities),
            "synthetic": self.synthetic,
            "example_questions": list(self.example_questions),
        }


class ActivePack:
    def __init__(self, data_dir: Path, registry: ToolRegistry, features: frozenset[str]) -> None:
        self.data_dir = data_dir
        self._families = registry.families(features)

    def manifest(self) -> dict[str, Any]:
        try:
            return json.loads((self.data_dir / "pack.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise PackUnavailableError("The active data pack is not built yet") from error

    def collection_manifest(self) -> dict[str, Any] | None:
        try:
            return json.loads((self.data_dir / "collection-manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def sources(self) -> list[Source]:
        manifest = self.manifest()
        structured = manifest.get("structured") or {}
        indexed = set((self.collection_manifest() or {}).get("source_ids", []))
        sources = []
        for entry in manifest.get("sources", []):
            capabilities = tuple(family for family in entry.get("capabilities", []) if family in self._families)
            if entry["kind"] == "documents" and entry["id"] not in indexed:
                capabilities = ()
            if not capabilities:
                continue
            sources.append(
                Source(
                    id=entry["id"],
                    name=entry["name"],
                    description=entry.get("description", ""),
                    agent_description=entry.get("agent_description") or entry.get("description", ""),
                    kind=entry["kind"],
                    capabilities=capabilities,
                    synthetic=bool(entry.get("synthetic", False)),
                    default_enabled=entry.get("default_enabled", True),
                    example_questions=tuple(entry.get("example_questions", [])),
                    database_name=structured.get("database_name") if entry["id"] == structured.get("source") else None,
                )
            )
        return sources

    def public_view(self) -> dict[str, Any]:
        """``GET /v1/pack``: what the UI shows on its landing page, and the conversations `demo-api record` asks."""
        manifest = self.manifest()
        available = {source.id for source in self.sources()}
        return {
            **{key: manifest.get(key) for key in ("id", "version", "title", "description", "as_of", "disclaimer")},
            "questions": [
                {key: question.get(key) for key in ("id", "label", "tag", "description", "question", "sources")}
                | {"featured": bool(question.get("featured", False))}
                for question in manifest.get("questions", [])
                if set(question.get("sources", [])) <= available
            ],
            "conversations": [
                {key: conversation.get(key) for key in ("id", "label", "tag", "description", "sources", "turns")}
                for conversation in manifest.get("conversations", [])
                if set(conversation.get("sources", [])) <= available
            ],
        }

    def database_path(self) -> Path | None:
        database = (self.manifest().get("structured") or {}).get("database")
        return self.data_dir / database if database else None
