# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Load a data pack, validate it, and resolve it for one build.

A pack is a directory with pack.yaml (schemas/pack.schema.json) and questions.yaml (schemas/questions.schema.json).
JSON Schema covers the shape; `cross_reference_errors` covers what a schema cannot express; `contract_errors`
checks the tables against a tool-owned contract such as tools/market-analytics/contract/market-analytics.v1.json.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Iterable
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import yaml
from jsonschema import Draft202012Validator
from jsonschema import FormatChecker

DATA_ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = DATA_ROOT / "schemas"
DIGEST_EXCLUDES = {"README.md", "eval", "recordings", "tests"}
# How contract types map to DuckDB types, unless the contract carries its own `logical_types`.
LOGICAL_TYPES = {
    "string": ["VARCHAR"],
    "date": ["DATE"],
    "timestamp": ["TIMESTAMP WITH TIME ZONE", "TIMESTAMP"],
    "float": ["DOUBLE", "FLOAT"],
    "integer": ["BIGINT", "INTEGER"],
    "boolean": ["BOOLEAN"],
}


class PackError(Exception):
    """A pack failed validation; `errors` lists every problem found."""

    def __init__(self, pack_id: str, errors: list[str]) -> None:
        super().__init__(f"{pack_id}: " + "; ".join(errors))
        self.errors = errors


@dataclass(frozen=True)
class Pack:
    directory: Path
    manifest: dict[str, Any]
    questions: list[dict[str, Any]]

    @property
    def id(self) -> str:
        return self.manifest["id"]

    @property
    def structured(self) -> dict[str, Any] | None:
        return self.manifest.get("structured")

    @property
    def database_name(self) -> str:
        return self.manifest["structured"]["database_name"]

    @property
    def tables(self) -> list[str]:
        return [table["name"] for table in self.structured["tables"]] if self.structured else []

    @property
    def database_tables(self) -> list[str]:
        """Tables loaded into DuckDB, in pack.yaml order."""
        if not self.structured:
            return []
        return [table["name"] for table in self.structured["tables"] if table.get("load_into_database", True)]

    @property
    def profiles(self) -> dict[str, Any]:
        return self.manifest["generator"]["profiles"] if "generator" in self.manifest else {}

    @property
    def origins(self) -> dict[str, dict[str, Any]]:
        return {origin["id"]: origin for origin in self.manifest["provenance"]}

    def path(self, relative: str) -> Path:
        return self.directory / relative

    def resolve_profile(self, requested: str | None) -> str:
        """The generator profile to build. A pack without a generator has the single profile `default`."""
        if "generator" not in self.manifest:
            if requested not in (None, "default"):
                raise PackError(self.id, [f"profile {requested!r} requested, but the pack has no generator"])
            return "default"
        name = requested or self.manifest["generator"]["default_profile"]
        if name not in self.profiles:
            raise PackError(self.id, [f"unknown profile {name!r}; choose one of {sorted(self.profiles)}"])
        return name

    def select_corpora(self, requested: Iterable[str] | None) -> list[dict[str, Any]]:
        """The corpora to build: those named in `requested`, or else every corpus that is not opt-in."""
        corpora = self.manifest.get("documents", {}).get("corpora", [])
        if requested is None:
            return [corpus for corpus in corpora if not corpus.get("opt_in", False)]
        wanted = set(requested)
        unknown = wanted - {corpus["source"] for corpus in corpora}
        if unknown:
            raise PackError(self.id, [f"no corpus for {sorted(unknown)}; choose from the pack's documents.corpora"])
        return [corpus for corpus in corpora if corpus["source"] in wanted]

    def digest(self, profile: str, corpora: list[dict[str, Any]], builder_version: str) -> str:
        """Content digest of everything a build depends on (README, eval/, recordings/ and tests/ excluded)."""
        sha = hashlib.sha256(f"{builder_version}\0{profile}\0".encode())
        sha.update(",".join(sorted(corpus["source"] for corpus in corpora)).encode())
        for file in sorted(self.directory.rglob("*")):
            relative = file.relative_to(self.directory)
            if file.is_file() and relative.parts[0] not in DIGEST_EXCLUDES and "__pycache__" not in relative.parts:
                sha.update(f"\0{relative.as_posix()}\0".encode())
                sha.update(file.read_bytes())
        return sha.hexdigest()

    def resolve(self, profile: str, corpora: list[dict[str, Any]]) -> dict[str, Any]:
        """The pack as one build sees it: only the sources and questions that the build can serve."""
        m = self.manifest
        served = ({self.structured["source"]} if self.structured else set()) | {c["source"] for c in corpora}
        resolved: dict[str, Any] = {
            key: m[key] for key in ("id", "version", "title", "description", "as_of", "disclaimer") if key in m
        }
        resolved |= {
            "profile": profile,
            "licenses": m["licenses"],
            "provenance": m["provenance"],
            "sources": [source for source in m["sources"] if source["id"] in served],
            "questions": [
                question
                for question in self.questions
                if set(question["sources"]) <= served and profile in question.get("profiles", [profile])
            ],
        }
        if self.structured:
            resolved["structured"] = {
                "source": self.structured["source"],
                "database_name": self.database_name,
                "database": f"structured/{self.database_name}.duckdb",
                "tables": {name: f"tables/{name}.parquet" for name in self.tables},
            }
        if "analytics" in m:
            analytics = m["analytics"]
            graph = analytics["relationship_graph"]
            resolved["analytics"] = {
                "contract": analytics["contract"],
                "news_table": analytics["news_table"],
                "session_close_utc": analytics["session_close_utc"],
                "universes": {
                    name: {"description": universe["description"], "where": universe["where"]}
                    for name, universe in analytics["universes"].items()
                    if profile in universe.get("profiles", [profile])
                },
                "relationship_graph": {
                    "window_start": graph["window_start"],
                    "window_end": graph["window_end"],
                    "mode": graph["mode_by_profile"][profile],
                },
            }
        if "prediction" in m:
            resolved["prediction"] = m["prediction"]
        if corpora:
            resolved["documents"] = {
                "collection": m["documents"].get("collection", f"{self.id.replace('-', '_')}_documents"),
                "sources": [corpus["source"] for corpus in corpora],
                "path": "corpus/documents.jsonl",
            }
        return resolved


def load_pack(directory: Path) -> Pack:
    """Load and validate a pack directory; raises PackError listing every problem."""
    manifest_path = directory / "pack.yaml"
    if not manifest_path.is_file():
        raise PackError(directory.name, [f"{manifest_path} not found"])
    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    errors = _schema_errors("pack.schema.json", manifest, "pack.yaml")
    if errors:
        raise PackError(directory.name, errors)
    questions_path = directory / manifest["questions"]
    if not questions_path.is_file():
        raise PackError(manifest["id"], [f"questions file {manifest['questions']} not found"])
    questions = yaml.safe_load(questions_path.read_text(encoding="utf-8"))
    errors = _schema_errors("questions.schema.json", questions, manifest["questions"])
    if errors:
        raise PackError(manifest["id"], errors)
    pack = Pack(directory, manifest, questions["questions"])
    errors = cross_reference_errors(pack)
    if errors:
        raise PackError(pack.id, errors)
    return pack


def _schema_errors(schema_name: str, document: Any, label: str) -> list[str]:
    schema = json.loads((SCHEMAS / schema_name).read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(document), key=lambda error: list(map(str, error.absolute_path)))
    return [f"{label}: {'/'.join(map(str, error.absolute_path)) or '(root)'}: {error.message}" for error in errors]


def cross_reference_errors(pack: Pack) -> list[str]:
    """Rules JSON Schema cannot express: ids that must resolve, files that must exist, names that must agree."""
    m = pack.manifest
    errors: list[str] = []
    sources = {source["id"]: source for source in m["sources"]}
    licenses = {license["name"] for license in m["licenses"]}
    profiles = set(pack.profiles)

    def require_file(relative: str, what: str) -> None:
        if not pack.path(relative).is_file():
            errors.append(f"{what} {relative} not found")

    def require_source(source_id: str, kind: str, what: str) -> None:
        if sources.get(source_id, {}).get("kind") != kind:
            errors.append(f"{what} must name a {kind} source, not {source_id!r}")

    for origin in m["provenance"]:
        if origin["license"] not in licenses:
            errors.append(f"origin {origin['id']}: unknown license {origin['license']!r}")
    errors += [f"origin {name} is declared twice" for name in _duplicates(o["id"] for o in m["provenance"])]

    if "generator" in m:
        require_file(m["generator"]["entrypoint"], "generator entrypoint")
        if m["generator"]["default_profile"] not in profiles:
            errors.append(f"generator.default_profile {m['generator']['default_profile']!r} is not a profile")

    structured = pack.structured
    if structured:
        snake_id = pack.id.replace("-", "_")
        if structured["database_name"] != snake_id:
            errors.append(f"structured.database_name must be {snake_id!r} (the pack id in snake_case)")
        require_source(structured["source"], "structured", "structured.source")
        require_file(structured["schema"], "schema")
        for view in structured.get("views", []):
            require_file(view, "view")
        if "ontology" in m:
            require_file(m["ontology"], "ontology")
        else:
            errors.append("a structured pack needs `ontology` (table and column descriptions)")
        errors += [f"table {name} is declared twice" for name in _duplicates(pack.tables)]
        for table in structured["tables"]:
            kind = pack.origins.get(table["origin"], {}).get("kind")
            if kind == "generated" and "generator" not in m:
                errors.append(
                    f"table {table['name']}: origin {table['origin']} is generated, but there is no generator"
                )
            elif kind == "committed":
                require_file(f"tables/{table['name']}.parquet", f"table {table['name']}:")
            elif kind not in ("generated", "committed"):
                errors.append(f"table {table['name']}: origin must be a generated or committed origin")
        for profile, spec in pack.profiles.items():
            for table in sorted(set(spec.get("expected_rows", {})) - set(pack.tables)):
                errors.append(f"profile {profile}: expected_rows names unknown table {table}")

    corpora = m.get("documents", {}).get("corpora", [])
    for corpus in corpora:
        label = f"corpus {corpus['source']}"
        require_source(corpus["source"], "documents", label)
        if corpus["origin"] not in pack.origins:
            errors.append(f"{label}: unknown origin {corpus['origin']!r}")
        manifest_path = pack.path(corpus["manifest"])
        if not manifest_path.is_file():
            errors.append(f"{label}: manifest {corpus['manifest']} not found")
        elif _json_object(manifest_path).get("source_id") != corpus["source"]:
            errors.append(f"{label}: manifest {corpus['manifest']} does not declare source_id {corpus['source']!r}")
    errors += [f"source {name} has more than one corpus" for name in _duplicates(c["source"] for c in corpora)]
    served = {corpus["source"] for corpus in corpora} | ({structured["source"]} if structured else set())
    errors += [f"source {source_id} has no corpus or structured data" for source_id in sorted(set(sources) - served)]

    if "analytics" in m:
        analytics = m["analytics"]
        if not structured or "market_analytics" not in sources.get(structured["source"], {}).get("capabilities", []):
            errors.append("analytics needs a structured source with the market_analytics capability")
        if analytics["news_table"] not in pack.tables:
            errors.append(f"analytics.news_table {analytics['news_table']!r} is not a table")
        if set(analytics["relationship_graph"]["mode_by_profile"]) != (profiles or {"default"}):
            errors.append("analytics.relationship_graph.mode_by_profile must name every profile")
        for name, universe in analytics["universes"].items():
            for profile in sorted(set(universe.get("profiles", [])) - profiles):
                errors.append(f"universe {name}: unknown profile {profile!r}")

    if "prediction" in m:
        prediction = m["prediction"]
        if not structured:
            errors.append("prediction needs a structured section")
        if prediction["entity"]["table"] not in prediction["tables"]:
            errors.append("prediction.entity.table must be one of prediction.tables")
        for template in prediction["templates"]:
            if not any(f"{table}." in template["pql"] for table in prediction["tables"]):
                errors.append(f"template {template['id']} references no prediction table")
        errors += [
            f"template {name} is declared twice" for name in _duplicates(t["id"] for t in prediction["templates"])
        ]

    errors += [f"question {name} is declared twice" for name in _duplicates(q["id"] for q in pack.questions)]
    for question in pack.questions:
        for source_id in sorted(set(question["sources"]) - set(sources)):
            errors.append(f"question {question['id']}: unknown source {source_id!r}")
        for profile in sorted(set(question.get("profiles", [])) - profiles):
            errors.append(f"question {question['id']}: unknown profile {profile!r}")
    if not any(question.get("featured") for question in pack.questions):
        errors.append("at least one question must be featured")
    return errors


def _duplicates(values: Iterable[str]) -> list[str]:
    return sorted(value for value, count in Counter(values).items() if count > 1)


def _json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def find_contracts(contracts_dir: Path | None = None) -> list[dict[str, Any]]:
    """Tool contracts: every *.json in `contracts_dir` (the image), else tools/*/contract/*.json (the repository)."""
    paths = contracts_dir.glob("*.json") if contracts_dir else (DATA_ROOT.parent / "tools").glob("*/contract/*.json")
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(paths)]


def contract_errors(
    contract: Mapping[str, Any],
    pack: Pack,
    connection: duckdb.DuckDBPyConnection,
    relations: Mapping[str, str],
) -> list[str]:
    """Check pack tables against one tool contract.

    `relations` maps a table name to a SQL relation on `connection`: a table, or read_parquet(...). A table that
    is declared but has no relation yet is only checked for presence. Enumerations and keys are checked on rows,
    so they only bite once the tables are built.
    """
    contract_id = contract.get("id", "?")
    if not isinstance(contract.get("tables"), dict):
        return [f"contract {contract_id}: no `tables` object"]
    logical_types = contract.get("logical_types", LOGICAL_TYPES)
    errors: list[str] = []
    for name, spec in contract["tables"].items():
        table = pack.manifest["analytics"]["news_table"] if name == "$news_table" else name
        if table not in pack.tables:
            errors.append(f"{contract_id}: table {table} is missing")
            continue
        relation = relations.get(table)
        if relation is None:
            continue
        described = connection.execute(f"SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM {relation})")
        columns = dict(described.fetchall())
        optional = {
            column: logical for column, logical in spec.get("optional_columns", {}).items() if column in columns
        }
        for column, logical in (spec.get("columns", {}) | optional).items():
            if column not in columns:
                errors.append(f"{contract_id}: {table}.{column} is missing")
            elif columns[column] not in logical_types.get(logical, ()):
                errors.append(f"{contract_id}: {table}.{column} is {columns[column]}, not {logical}")
        for column, values in spec.get("enums", {}).items():
            if column in columns:
                allowed = ", ".join(sql_literal(value) for value in values)
                (outside,) = connection.execute(
                    f"SELECT count(*) FROM {relation} WHERE {column} NOT IN ({allowed})"
                ).fetchone()
                if outside:
                    errors.append(f"{contract_id}: {table}.{column} has {outside} rows outside {values}")
        for key in spec.get("unique", []) + ([spec["primary_key"]] if "primary_key" in spec else []):
            if set(key) <= set(columns):
                (duplicates,) = connection.execute(
                    f"SELECT count(*) - count(DISTINCT ({', '.join(key)})) FROM {relation}"
                ).fetchone()
                if duplicates:
                    errors.append(f"{contract_id}: {table} has {duplicates} duplicate {tuple(key)} keys")
    return errors


def applicable_contracts(pack: Pack, contracts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The contracts this pack declares (analytics.contract) among those found."""
    declared = pack.manifest.get("analytics", {}).get("contract")
    return [contract for contract in contracts if contract.get("id") == declared]


def declared_contract_errors(pack: Pack, contracts: list[dict[str, Any]]) -> list[str]:
    """Check the tables as schema.sql declares them against the pack's contracts, before anything is built."""
    applicable = applicable_contracts(pack, contracts)
    if not applicable:
        return []
    with duckdb.connect() as connection:
        connection.execute(pack.path(pack.structured["schema"]).read_text(encoding="utf-8"))
        relations = {table: f"main.{table}" for table in pack.database_tables}
        return [error for contract in applicable for error in contract_errors(contract, pack, connection, relations)]


def sql_literal(value: Any) -> str:
    """A SQL literal for a string or a number."""
    return "'" + value.replace("'", "''") + "'" if isinstance(value, str) else str(value)
