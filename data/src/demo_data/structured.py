# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Build the structured part of a pack: Parquet tables, the DuckDB database, the ontology and the prediction graph.

tables/<table>.parquet               every table (the generator's output, or copied from the pack)
structured/<database_name>.duckdb    schema.sql, then the tables, then the rendered views
ontology/model.yaml                  Auto Ontology model
prediction/graph.json                prediction views, keys, time columns, anchor and population
prediction/templates.json            PQL templates
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from datetime import UTC
from datetime import datetime
from pathlib import Path
from typing import Any

import duckdb
import yaml

from demo_data import ontology
from demo_data.pack import Pack
from demo_data.pack import applicable_contracts
from demo_data.pack import contract_errors
from demo_data.pack import sql_literal

# The readers (api, market-analytics, Auto Ontology) may lag behind this builder's DuckDB. Pinning the on-disk
# format (DuckDB 1.5's default today) stops a writer upgrade from silently changing it; these files open in
# DuckDB 1.1.3 and later. Still upgrade the readers before the writer.
STORAGE_VERSION = "v1.0.0"


class BuildError(Exception):
    """The structured build produced data that does not match the pack."""


def build(pack: Pack, profile: str, contracts: list[dict[str, Any]], out: Path) -> dict[str, Any]:
    """Build every structured artifact under `out` and return row counts per table."""
    tables_dir = out / "tables"
    produce_tables(pack, profile, tables_dir)
    rows = check_tables(pack, profile, contracts, tables_dir)
    database = out / "structured" / f"{pack.database_name}.duckdb"
    load_database(pack, tables_dir, database)
    model = ontology.build_model(pack, database)
    write_text(out / "ontology" / "model.yaml", yaml.safe_dump(model, sort_keys=False, allow_unicode=True))
    if "prediction" in pack.manifest:
        write_prediction(pack, database, out / "prediction")
    return rows


def produce_tables(pack: Pack, profile: str, tables_dir: Path) -> None:
    """Run the generator for generated tables and copy committed ones."""
    tables_dir.mkdir(parents=True, exist_ok=True)
    tables = pack.structured["tables"]
    if any(pack.origins[table["origin"]]["kind"] == "generated" for table in tables):
        entrypoint = pack.path(pack.manifest["generator"]["entrypoint"])
        command = [sys.executable, str(entrypoint), "--profile", profile, "--out", str(tables_dir)]
        subprocess.run(command, check=True, cwd=pack.directory)
    for table in tables:
        if pack.origins[table["origin"]]["kind"] == "committed":
            shutil.copyfile(pack.path(f"tables/{table['name']}.parquet"), tables_dir / f"{table['name']}.parquet")
    missing = [name for name in pack.tables if not (tables_dir / f"{name}.parquet").is_file()]
    if missing:
        raise BuildError(f"the generator did not write {missing}")


def check_tables(pack: Pack, profile: str, contracts: list[dict[str, Any]], tables_dir: Path) -> dict[str, int]:
    """Check the Parquet tables against the pack's tool contracts and the profile's expected row counts."""
    with duckdb.connect() as connection:
        relations = {name: f"read_parquet({sql_literal(str(tables_dir / f'{name}.parquet'))})" for name in pack.tables}
        errors = [
            error
            for contract in applicable_contracts(pack, contracts)
            for error in contract_errors(contract, pack, connection, relations)
        ]
        rows = {
            name: connection.execute(f"SELECT count(*) FROM {relation}").fetchone()[0]
            for name, relation in relations.items()
        }
    expected = pack.profiles.get(profile, {}).get("expected_rows", {})
    errors += [
        f"{table} has {rows[table]:,} rows; profile {profile} expects {count:,}"
        for table, count in expected.items()
        if rows[table] != count
    ]
    if errors:
        raise BuildError("; ".join(errors))
    return rows


def load_database(pack: Pack, tables_dir: Path, database: Path) -> None:
    """schema.sql, then every database table from Parquet (columns matched by name), then the views."""
    database.parent.mkdir(parents=True, exist_ok=True)
    config = {"storage_compatibility_version": STORAGE_VERSION}
    with duckdb.connect(str(database), config=config) as connection:
        connection.execute(pack.path(pack.structured["schema"]).read_text(encoding="utf-8"))
        for table in pack.database_tables:
            connection.execute(
                f"INSERT INTO main.{table} BY NAME SELECT * FROM read_parquet(?)",
                [str(tables_dir / f"{table}.parquet")],
            )
        for view in pack.structured.get("views", []):
            connection.execute(render_view(pack, pack.path(view).read_text(encoding="utf-8")))
        connection.execute("CHECKPOINT")


def render_view(pack: Pack, sql: str) -> str:
    """Fill the {{placeholders}} of a view file from the prediction section."""
    values: dict[str, str] = {}
    if "prediction" in pack.manifest:
        prediction = pack.manifest["prediction"]
        anchor = datetime.fromisoformat(prediction["anchor"]).astimezone(UTC)
        values = {
            "anchor_date": anchor.date().isoformat(),
            "anchor_timestamp": anchor.isoformat(),
            "horizon_sessions": str(prediction["horizon_sessions"]),
            "population_literals": ", ".join(sql_literal(entity) for entity in prediction["population"]["ids"]),
        }
    for name, value in values.items():
        sql = sql.replace("{{" + name + "}}", value)
    if "{{" in sql:
        raise BuildError(f"unresolved placeholder in view SQL near {sql[sql.index('{{') :][:40]!r}")
    return sql


def write_prediction(pack: Pack, database: Path, out: Path) -> None:
    """The prediction graph as built (with each view's row count) and its PQL templates."""
    prediction = pack.manifest["prediction"]
    schema = prediction["schema"]
    with duckdb.connect(str(database), read_only=True) as connection:
        rows = {
            name: connection.execute(f"SELECT count(*) FROM {schema}.{name}").fetchone()[0]
            for name in prediction["tables"]
        }
        population = [
            row[0]
            for row in connection.execute(f"SELECT * FROM {schema}.{prediction['population']['view']}").fetchall()
        ]
    missing = sorted(set(prediction["population"]["ids"]) - set(population))
    if missing:
        raise BuildError(f"population ids are not entities at the anchor: {missing}")
    graph = {
        "schema": schema,
        "anchor": prediction["anchor"],
        "horizon_sessions": prediction["horizon_sessions"],
        "entity": prediction["entity"],
        "population": prediction["population"],
        "tables": [
            {
                "name": name,
                "primary_key": table["primary_key"],
                "time_column": table.get("time_column"),
                "links_to_entity": table.get("links_to_entity"),
                "rows": rows[name],
            }
            for name, table in prediction["tables"].items()
        ],
        "forbidden_tables": prediction.get("forbidden_tables", []),
    }
    write_text(out / "graph.json", json.dumps(graph, indent=2) + "\n")
    write_text(out / "templates.json", json.dumps({"templates": prediction["templates"]}, indent=2) + "\n")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
