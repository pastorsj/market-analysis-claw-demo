# market-analytics

An MCP server (streamable HTTP at `:3010/mcp`) with six read-only market tools, plus Kumo prediction when a
Kumo Relational endpoint is configured. Hermes calls them as `mcp__market_analytics__<tool>`. The tools run on
pandas, scikit-learn and NetworkX; the GPU image runs the same code on RAPIDS (cuDF, cuML, cuGraph).

| Question | Tool | CPU | GPU |
| --- | --- | --- | --- |
| Leaders and laggards by return, volume, volatility or peer-relative return | `market_scan` | pandas | cudf.pandas |
| Sessions that behave unusually against an earlier baseline | `market_anomaly_scan` | scikit-learn PCA | cuml.accel |
| Return, price range and volume for named assets | `price_context` | pandas | cudf.pandas |
| Positive, neutral and negative news labels over time | `sentiment_timeline` | pandas | cudf.pandas |
| How news sentiment lined up with later returns | `analyze_news_price_relationship` | pandas | cudf.pandas |
| Most central assets in the return-correlation graph | `analyze_market_relationships` | `nx.pagerank` | nx-cugraph |
| Probability of a curated future outcome per asset | `predict_asset_outcomes` | Kumo Relational (a NIM) | same |

The results are descriptive. This service makes no speedup claims: each result names the device, library and
time it used, and nothing more.

## How it fits

- **Data.** The `data` one-shot builds the active pack at `/data/active`. The server reads `pack.json`, the
  Parquet tables under `tables/`, and (for prediction only) `structured/<database_name>.duckdb`. It checks the
  tables against [`contract/market-analytics.v1.json`](contract/market-analytics.v1.json) at startup, the same
  file `demo-data validate` uses. Universes, the graph window and the prediction templates come from the pack,
  so no dataset facts live in this code. The server resolves the `/data/active` symlink once at startup, and
  every worker, including a replacement, loads that build: restart the service after activating another pack.
- **Worker.** One spawned process loads and derives the tables once (prices, anomaly features, news aligned to
  sessions, the correlation graph), makes one warm-up `market_scan` call so the first question does not pay
  cudf.pandas' first-call cost, and runs every call under a deadline. A call that overruns, or a crash,
  kills the worker and a fresh one replaces it, so the next call succeeds. The tools are async and wait for the
  worker on a thread, so `tools/list` and other requests stay responsive. `GET /health` is 200 while the
  worker is up.
- **Results.** Every market tool returns a `MarketResult` (see `src/market_analytics/models.py`): `status`
  (`succeeded`, `empty` or `failed`), `source_id`, `database_name`, the tool's `payload`, `error`,
  `engine {device, library, version}`, `timing {compute_ms, total_ms}`, `rows_scanned`, `warnings` and
  `limitations`. This is what the execution receipt shows. Failures (bad arguments, deadlines, a dead worker)
  are results too, because MCP clients drop the structured content of an error response. An error message is
  at most 1,000 characters, the receipt's limit.
- **Scope.** Every tool takes an optional `source_ids`, which the Hermes plugin sets to the run's selected
  sources. A market tool refuses (`source_not_selected`) when the pack's structured source is not among them.
- **Prediction.** `predict_asset_outcomes(template_id, asset_ids?)` runs one of the pack's curated PQL
  templates (`pack.json` → `prediction.templates`) with `kumo-relational-client`. It returns `available` /
  `reason`, `template_id`, `pql`, `anchor`, `horizon {value, unit}` (read from the PQL window), and
  `rows [{asset_id, probability}]`. It is registered only when `KUMO_RELATIONAL_URL` is set. A prediction is
  one attempt with a 60 s timeout and no retries, so a slow NIM returns `available: false` before the agent's
  MCP timeout (180 s). Never install the client's `[explain]` extra: it sends raw cell values to a third-party
  LLM.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATA_ACTIVE_DIR` | `/data/active` | The active data pack |
| `MARKET_ANALYTICS_ENGINE` | `cpu` | `gpu` installs cudf.pandas, cuml.accel and nx-cugraph in the worker (GPU image only) |
| `MARKET_ANALYTICS_TIMEOUT_SECONDS` | `120` | How long one call may run before the worker is replaced |
| `KUMO_RELATIONAL_URL` | unset | Kumo Relational NIM, e.g. `http://kumo-relational:8000`; enables `predict_asset_outcomes` |
| `KUMO_API_KEY` | unset | Only for an authenticating gateway in front of the NIM (sent as `X-API-Key`) |

## Run

```bash
# Locally, against a built pack
DATA_ACTIVE_DIR=/path/to/active uv run --project tools/market-analytics market-analytics-server

# CPU image (the default: ANALYTICS_EXTRAS=kumo)
docker build -t market-demo/market-analytics:local tools/market-analytics

# GPU image: RAPIDS 26.06 for CUDA 12 (driver 535 or newer) on Linux; run it with gpus: all and
# MARKET_ANALYTICS_ENGINE=gpu
docker build --build-arg ANALYTICS_EXTRAS=gpu-cu12,kumo -t market-demo/market-analytics-gpu:local tools/market-analytics
```

The console script is `market_analytics.bootstrap:main`. Start the server through it: the worker installs the
RAPIDS accelerators before anything imports pandas, which only works because the entry module imports nothing
heavy (a spawned process re-imports it first).

## Test

```bash
cd tools/market-analytics
uv run pytest          # offline: a tiny fixture pack and a stubbed Kumo client; the GPU tests skip without a GPU
uv run pytest -m gpu   # on a GPU host, after `uv sync --extra gpu-cu12`: CPU/GPU parity for every tool
KUMO_RELATIONAL_URL=... KUMO_API_KEY=... DATA_ACTIVE_DIR=/path/to/active uv run pytest -m live  # one real prediction
```

cudf.pandas falls back to pandas where it has no GPU path, and loading a pack already does (`tz_localize`
with a string time zone). So `CUDF_PANDAS_FAIL_ON_FALLBACK=1`, which turns the first fallback into an error,
stops the worker while it loads and every GPU test errors; the parity run above passes without it. Lint with
the repository's `ruff.toml`: `uv run ruff check . && uv run ruff format --check .`

## Changing the contract

A new optional column is a minor change. Renaming or removing a required column, or changing its type, needs
a new contract id (`market-analytics/v2`), because packs declare the contract they satisfy.
