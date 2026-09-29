# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Import the active data pack's ontology into Auto Ontology.

The model is derived by `demo-data prepare` (ontology/model.yaml), so Auto Ontology's own LLM compiler never runs.
Run it after the backend is healthy and before ingestion first starts, so ingestion converges onto the imported IDs
instead of cataloging the database a second time. The import replaces the previous model, so it is safe to repeat.

Standard library only: it runs in the backend image with `python /seed.py`.

Env: AUTO_ONTOLOGY_API_URL (default http://auto-ontology:3001), AUTO_ONTOLOGY_MODEL
(default /data/active/ontology/model.yaml), AUTO_ONTOLOGY_SEED_TIMEOUT_S (default 600; embedding every term is slow).
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def import_model(api_url: str, model: Path, timeout: float) -> dict[str, Any]:
    """POST the YAML model with replace=true and embed=true; return the import summary."""
    request = urllib.request.Request(
        f"{api_url.rstrip('/')}/api/model/import?replace=true&embed=true",
        data=model.read_bytes(),
        method="POST",
        headers={"Content-Type": "application/x-yaml", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    if payload.get("success") is not True:
        raise RuntimeError(f"the import did not report success: {payload}")
    return payload.get("summary") or {}


def main() -> int:
    api_url = os.environ.get("AUTO_ONTOLOGY_API_URL", "http://auto-ontology:3001")
    model = Path(os.environ.get("AUTO_ONTOLOGY_MODEL", "/data/active/ontology/model.yaml"))
    timeout = float(os.environ.get("AUTO_ONTOLOGY_SEED_TIMEOUT_S", "600"))
    try:
        summary = import_model(api_url, model, timeout)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1000]
        print(f"seed: {api_url} rejected {model}: HTTP {error.code} {detail}", file=sys.stderr)
        return 1
    except (OSError, RuntimeError, ValueError) as error:
        print(f"seed: could not import {model} into {api_url}: {error}", file=sys.stderr)
        return 1
    print(f"seed: imported {model} into {api_url}: {json.dumps(summary, sort_keys=True)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
