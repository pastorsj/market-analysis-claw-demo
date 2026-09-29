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

The results are descriptive. Each result names the device, library and time it used, and nothing more; the
measured difference between the two engines is under [CPU and GPU timings](#cpu-and-gpu-timings).

## How it fits

- **Data.** The `data` one-shot builds the active pack at `/data/active`. The server reads `pack.json`, the
  Parquet tables under `tables/`, and (for prediction only) `structured/<database_name>.duckdb`. It checks the
  tables against [`contract/market-analytics.v1.json`](contract/market-analytics.v1.json) at startup, the same
  file `demo-data validate` uses. Universes, the graph window and the prediction templates come from the pack,
  so no dataset facts live in this code. The server resolves the `/data/active` symlink once at startup, and
  every worker, including a replacement, loads that build: restart the service after activating another pack.
- **Worker.** One spawned process loads and derives the tables once (prices, anomaly features, news aligned to
  sessions, the correlation graph), runs every tool once as a warm-up so the first question does not pay the GPU
  libraries' first-call costs, and runs every call under a deadline. A call that overruns, or a crash,
  kills the worker and a fresh one replaces it, so the next call succeeds. The tools are async and wait for the
  worker on a thread, so `tools/list` and other requests stay responsive. `GET /health` is 200 while the
  worker is up.
- **Results.** Every market tool returns a `MarketResult` (see `src/market_analytics/models.py`): `status`
  (`succeeded`, `empty` or `failed`), `source_id`, `database_name`, the tool's `payload`, `error`,
  `engine {device, library, version}`, `timing {compute_ms, total_ms}`, `rows_scanned`, `warnings` and
  `limitations`. This is what the execution receipt shows. Failures (bad arguments, deadlines, a dead worker)
  are results too, because MCP clients drop the structured content of an error response. An error message is
  at most 1,000 characters, the receipt's limit.
- **Timestamps.** Inside the worker every timestamp is tz-naive UTC `datetime64[ns]`: `data.py` normalizes the
  tables once at load, the dispatcher converts timezone-aware arguments to UTC, and the result models put the
  UTC offset back, so results still read `2026-08-24T21:00:00Z`. cudf.pandas cannot keep a tz-aware column on
  the GPU; with one, every operation on the frame fell back to pandas.
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

cudf.pandas falls back to pandas where it has no GPU path. Loading a pack does so twice (`merge_asof` and
`rename_axis`, once each at startup), so `CUDF_PANDAS_FAIL_ON_FALLBACK=1`, which turns the first fallback into
an error, stops the worker while it loads and every GPU test errors; the parity run above passes without it. To
list fallbacks instead, set `LOG_FAST_FALLBACK=1` (cudf.pandas writes them to
`cudf_pandas_unit_tests_debug.log` in the working directory) or run a call under `cudf.pandas.profiler.Profiler`.
Lint with the repository's `ruff.toml`: `uv run ruff check . && uv run ruff format --check .`

## CPU and GPU timings

Measured on a 40 GB A100 VM with 12 vCPUs, on the qualification pack (2,000 issuers, 1.36 million daily
bars, 84,000 news items). The method: a throwaway container from the stack's own GPU image, with `--gpus all`
and the pack mounted read-only, ran the service's worker with `MARKET_ANALYTICS_ENGINE=cpu` and then with
`gpu`, never both at once, while the rest of the stack sat idle. Each call ran once to warm up, then five timed
repeats. The time is the tool's own compute timer, the one receipts show. Median milliseconds:

| Call | CPU | GPU | CPU/GPU |
| --- | --- | --- | --- |
| `market_scan`, 2,000 issuers, 2024 to 2026, return and volatility | 229 | 77 | 3.0x |
| `market_scan`, 2,000 issuers, volume z-score | 228 | 82 | 2.8x |
| `market_scan`, 12 reviewed assets, 20 sessions | 86 | 56 | 1.5x |
| `market_anomaly_scan`, 12 assets | 76 | 41 | 1.8x |
| `market_anomaly_scan`, 2,000 issuers | 291 | 119 | 2.5x |
| `price_context`, 3 assets, 21 sessions | 70 | 33 | 2.1x |
| `sentiment_timeline`, 22,000 news items, weekly | 29 | 40 | 0.7x |
| `analyze_news_price_relationship`, 2,000 news items | 746 | 92 | 8.1x |
| `analyze_market_relationships`, top 10 | 37 | 37 | 1.0x |

Both engines returned the same results for every call (floats within 1e-4). On the GPU, the first call after
the worker reported ready took at most 140 ms, here and for a dozen other argument shapes, because the
warm-up had paid the one-time cost: about 11 s, nearly all of it cudf.pandas compiling kernels for the first
`market_scan`. Starting the worker, warm-up included, took 25 s on the GPU and 10 s on the CPU.

`sentiment_timeline` is slower on the GPU and `analyze_market_relationships` breaks even. Their work is
small: the first groups 22,000 news rows into 11 weekly points, the second runs PageRank on 2,000 nodes and
sorts 16,000 edges. At that size the fixed cost of each GPU operation (launching kernels, waiting for them,
copying results back to the host) outweighs the arithmetic, which pandas and NetworkX finish in about 30 ms.

Before the [timestamp change](#how-it-fits) the GPU engine was slower on every call (0.1x to 0.9x; for
example 1,560 ms against 250 ms for the first `market_scan` row), because every operation on a frame with a
tz-aware column fell back to pandas. The CPU results did not change.

## Changing the contract

A new optional column is a minor change. Renaming or removing a required column, or changing its type, needs
a new contract id (`market-analytics/v2`), because packs declare the contract they satisfy.
