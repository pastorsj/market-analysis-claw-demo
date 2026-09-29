# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""demo-retrieval serve | ingest"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from . import ingest
from . import server
from .settings import Settings


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="demo-retrieval", description=__doc__)
    parser.add_argument("command", choices=["serve", "ingest"], help="serve retrieve_evidence, or build the index")
    parser.add_argument("--data-dir", type=Path, default=Path("/data/active"), help="the active data pack")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    try:
        settings = Settings.from_env()
    except ValueError as error:
        parser.error(str(error))
    if args.command == "ingest":
        ingest.run(settings, args.data_dir)
    else:
        _export_traces()
        server.serve(settings, args.data_dir)


def _export_traces() -> None:
    """Send the embed/search/rerank spans to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (Phoenix), when it is set."""
    if not os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"):
        return
    provider = TracerProvider(resource=Resource.create({"service.name": "retrieval"}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)


if __name__ == "__main__":
    main()
