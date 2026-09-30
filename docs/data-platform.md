<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Data platform

This is the design for the demo's data: two market packs in one format, external data that is never
committed, a fetch step, an importer that scales past a few gigabytes, and the questions each pack answers.
It extends [data packs](data-packs.md) and [`data/README.md`](../data/README.md). Where the three disagree,
this page wins until the code catches up. Once it has, those pages describe the result.

## Rules

1. **Real market data is never committed.** It lives outside the repository in `DATA_SOURCE_DIR`, reaches
   a machine through `demo.sh data fetch`, and is pinned by a digest. The repository holds only that digest,
   synthetic data and small synthetic fixtures.
2. **Scale is a property of the format, not of one dataset.** Nothing loads the raw minute bars whole. The
   first real input, `bfdmini` (1.7 GB, 117 million minute bars for 2,200 US tickers), is a test case, not a
   ceiling.
3. **Two packs, one format.** `synthetic-market` (NeMo Data Designer) is the public default. `us-equities`
   (real minute bars) is optional and private. Both produce the same tables through the same importer.
4. **SEC EDGAR filings are a separate document source** in both packs, searched by retrieval. They are
   never converted into news events and never written to a news table.
5. **GDELT headlines are an optional, separate document source.** They are not linked to tickers.
6. **The news tools need a ticker-linked news table.** `synthetic-market` has one. A pack without one
   declares none, and `sentiment_timeline` and `analyze_news_price_relationship` report that they are
   unavailable.
7. The fictional briefs are dropped. The UI name does not change.

## Overview

```text
  source (local, rsync, https, s3, gs, hf)
        │  demo.sh data fetch: manifest digest pinned in pack.yaml, sha256 per file
        ▼
  DATA_SOURCE_DIR/<dataset>/      raw Parquet, read in place, read-only to every service
        │  rollup: one DuckDB pass, streamed, cached by manifest digest
        ▼
  /data/cache/rollups/<key>/      daily bars per symbol
        │  import: sessions, exclusions, companies, peers, news (if any)
        ▼
  /data/builds/<build>/           tables/*.parquet, DuckDB (views over the Parquet), ontology, prediction
        ▲
  /data/active ──▶ api, market-analytics, Auto Ontology, retrieval (unchanged)
```

`synthetic-market` goes in at the same place. At build time its generator writes a raw dataset in the
canonical layout into `/data/cache/generated/`, and the same rollup and import run on it.

## The packs

| | `synthetic-market` (default) | `us-equities` (optional) | `market-analysis` (retiring) |
|---|---|---|---|
| Prices | Generated from seeds, 1 day or 1 minute bars | Real split-adjusted 1-minute bars, rolled up to daily | Old generator |
| Issuers | Fictional, named by Nemotron, checked against the SEC ticker list | Real, with SEC names, CIKs and SIC codes | Fictional |
| Ticker-linked news | `company_news`: seeded events, Nemotron headlines | None; the news tools report unavailable | `market_news` |
| Documents | `sec_filings` (SEC EDGAR 2026 Q2), `market_regulations` (eCFR Title 17) | `sec_filings` (8-Ks by the pack's issuers), `market_regulations`, `world_news` (GDELT, opt-in) | Also the briefs |
| Committed | Everything, including the Nemotron text for the committed profiles | The pack definition and the dataset digest only | – |
| Needs | No key for the structured part; `SEC_USER_AGENT` for `sec_filings`, as today | `data fetch`; `SEC_USER_AGENT` for company metadata and `sec_filings` | – |

`market-analysis` is retired once `synthetic-market` validates. Its generator, briefs and questions go, and
`DATA_PACK` defaults to `synthetic-market`. Its `recordings/` directory stays until the new packs are
recorded, because replay needs only the bundle.

The structured source is `market_data` in both packs. The SEC filings source is `sec_filings`, not
`market_news`, so the name no longer suggests a news table.

## Pack format v2

`schema_version: "2"` adds two optional sections to v1: `external` (datasets outside the repository) and
`market` (how the importer turns bars into tables). A v1 pack stays valid until `market-analysis` is removed,
and then v1 support goes too. Everything else in the v1 format is kept (`structured`, `documents`, `sources`,
`analytics`, `prediction`, `ontology`, `questions`), with the changes listed below.

```yaml
schema_version: "2"
id: us-equities
version: "1.0.0"
as_of: "2026-03-12"

external:
  minute-bars:                          # fetched into $DATA_SOURCE_DIR/minute-bars/
    title: US equities, 1-minute split-adjusted bars
    manifest: benchmark-bundle-manifest.json    # path inside the dataset
    fingerprint: d8b405106b9cda1e691f6204a85219e45ab1b392008e982087e732964f713899
    bytes: 1812697046                   # for doctor's disk check
    # Fetched from $DATA_SOURCE_MINUTE_BARS (the id, upper-cased, - to _)

provenance:
  - { id: minute-bars, kind: external, synthetic: false, requires_env: [SEC_USER_AGENT] }

market:
  bars:
    dataset: minute-bars
    files: market/stocks_1min/*_full_1min_adjsplit.parquet
    symbol_from_path: '([^/]+)_full_1min_adjsplit\.parquet$'   # or symbol_column: symbol
    columns: { time: ts, open: open, high: high, low: low, close: close, volume: volume }
    frequency: 1min                     # 1min | 1d
    timezone: America/New_York          # the zone of the time column's wall-clock values
    regular_session: ["09:30", "16:00"] # both ends included
  companies: sec                        # sec | a Parquet path in the dataset
  news: null                            # or a Parquet path in the dataset
  exclude: [warrants, units, rights, preferred]
  min_sessions: 20

structured:
  source: market_data
  database_name: us_equities
  schema: schema.sql
  views: [views/prediction.sql]
  tables:                               # the importer's fixed table set
    - { name: assets, origin: minute-bars }
    - { name: ticker_history, origin: minute-bars }
    - { name: trading_sessions, origin: minute-bars }
    - { name: daily_prices, origin: minute-bars, storage: parquet,
        primary_key: [price_id], foreign_keys: { asset_id: assets.asset_id } }
    - { name: asset_relationships, origin: minute-bars }

analytics:
  news_table: null                      # no ticker-linked news in this pack
  session_close_utc: "21:00"
```

| Key | Meaning |
|---|---|
| `external.<id>` | A dataset outside the repository: its manifest path, its pinned `fingerprint` and its size. The host path is `$DATA_SOURCE_DIR/<id>`, mounted read-only at `/sources/<id>`. |
| `market.bars` | Where the bars are and how to read them in place: a glob, where the symbol comes from (a path pattern or a column), the column mapping, the bar frequency, the time zone of the timestamps and the regular session. |
| `market.companies` | `sec` joins SEC company metadata to the symbols. A path reads a companies table from the dataset. |
| `market.news` | A path to a ticker-linked news table in the dataset, or `null`. |
| `market.exclude`, `min_sessions` | Which symbols the importer drops (see [import](#import)). |
| `tables[].storage: parquet` | The DuckDB file gets a view over the build's Parquet instead of a copy of the rows. Keys for such a view are declared here, because a view carries no constraints. The ontology builder reads them, as it already does for the prediction views. |
| `analytics.news_table` | May be `null`. |
| `prediction.population` | May name only a `view`. The builder resolves the ids into `pack.json`, so readers still see `ids`. |
| `provenance[].kind: external` | A new provenance kind, next to `generated`, `committed` and `download`. The importer writes every table whose `origin` is an `external` entry (in `synthetic-market`, the `generated` entry of its generator). |

The build digest already covers `pack.yaml`, so it covers the pinned fingerprints too. A build of a pack
with external data starts only when every dataset it uses has been verified (next section).

## The manifest

An external dataset carries its manifest at a fixed path inside it. The format is BFD's benchmark bundle
manifest, so `bfdmini` works as it is:

```json
{
  "format": "market-demo-dataset",
  "version": 1,
  "created_at": "2026-09-28T15:29:24Z",
  "dataset_fingerprint": "<sha256 hex>",
  "file_count": 2206,
  "total_bytes": 1812697046,
  "files": [ { "path": "market/stocks_1min/AAPL_full_1min_adjsplit.parquet", "bytes": 3865509, "sha256": "<hex>" } ]
}
```

- `files` is sorted by `path`, and the paths are relative POSIX paths. The manifest does not list itself.
- `dataset_fingerprint = sha256(json.dumps(files, sort_keys=True, separators=(",", ":")))`. This is BFD's
  own algorithm; recomputing it over the `bfdmini` manifest gives the fingerprint its README publishes.
- Other keys, such as `format`, `proof_scale` or per-symbol row counts, are informational and ignored.
- The pack commits only the fingerprint. The manifest travels with the data: it lists every file name and
  grows with the dataset, so committing it would not scale.

Verification has two levels:

1. **The manifest.** Recompute the fingerprint from `files` and compare it with the pin. A mismatch means a
   different dataset, and nothing proceeds.
2. **The files.** Check each file's size and SHA-256. The results are recorded in
   `$DATA_SOURCE_DIR/<id>/.verified.json` as `path → [bytes, mtime_ns, sha256]`. `fetch` re-hashes only files
   whose size or mtime changed, so it can resume. `prepare` sees the directory read-only: it compares sizes
   and mtimes with the record, which is cheap, and if anything changed it stops and asks for
   `data fetch --verify-only`. Files that the manifest does not list are reported but never deleted.

## `demo.sh data fetch`

```bash
./scripts/demo.sh data fetch                 # every external dataset of $DATA_PACK
./scripts/demo.sh data fetch minute-bars     # one dataset
./scripts/demo.sh data fetch --verify-only   # hash what is already in DATA_SOURCE_DIR
```

The source of dataset `<id>` is the `.env` variable `DATA_SOURCE_<ID>` (upper case, `-` becomes `_`). If
it is empty, fetch only verifies what is already in place.

| Source | Example | Credentials (`.env`) | Runs |
|---|---|---|---|
| Local directory | `/mnt/datasets/bfdmini` or `file:///mnt/…`, mounted read-only into the fetch run | – | in the data image |
| rsync over SSH | `user@host:/srv/bfdmini` | the host's SSH agent and keys | on the host, then `--verify-only` in the image |
| HTTPS | `https://example.com/bfdmini/` (a prefix; files are fetched as `<prefix><path>`), or one `.tar`, `.tar.gz` or `.tar.zst` archive (a pre-signed URL works) | `DATA_SOURCE_HTTP_TOKEN` (optional, sent as a bearer token) | in the data image |
| S3 or S3-compatible | `s3://bucket/prefix` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_ENDPOINT_URL` | in the data image |
| Google Cloud Storage | `gs://bucket/prefix` | `GOOGLE_APPLICATION_CREDENTIALS`: a host path to a service-account JSON, mounted read-only (empty for a public bucket) | in the data image |
| Hugging Face | `hf://datasets/<owner>/<name>@<revision>/<prefix>` | `HF_TOKEN` | in the data image |

- The procedure: get the manifest and check its fingerprint (for an archive, after unpacking it into a
  staging directory). Then fetch each missing or changed file to
  `<path>.part`, hashing it while it streams, and rename it only when the hash matches. Downloads run in
  parallel (`DATA_FETCH_JOBS`, default 8) with three retries each.
- Remote schemes use fsspec, through `s3fs`, `gcsfs`, `huggingface_hub` and its HTTP filesystem. They are
  the data project's `fetch` extra. rsync runs on the host because it needs the host's SSH identity.
- **Credentials.** They live only in `.env`, which is git-ignored. `demo.sh` passes only the variables of
  the chosen scheme to the one-shot fetch container, as `-e NAME` so the values never appear on a command
  line. No long-running service receives them.
- NGC is not a scheme. Download an NGC resource with its CLI, then use it as a local directory.
- `DATA_SOURCE_DIR` defaults to `$HOME/market-demo-data`, outside the repository, so the data cannot be
  staged by accident. `.gitignore` also ignores `data/external/` for anyone who points it there. A CI step
  fails if a `.parquet` or `.duckdb` file is committed outside `data/packs/*/text/` and the test fixtures.
- **Brev and other VMs.** Point `DATA_SOURCE_DIR` at the large disk. At setup, run `data fetch` from a
  bucket, or push from a laptop with `rsync -a <bfdmini>/benchmark-subset/ <vm>:$DATA_SOURCE_DIR/minute-bars/`
  and then run `data fetch --verify-only` on the VM.

## Storage layout

**Raw bars are read in place, in the layout they arrive in.** A layout is readable when it is Parquet, when
the symbol can be found in a column or in the path, and when the files are ordered by time.

- **`bfdmini`** has one file per symbol (`<SYMBOL>_full_1min_adjsplit.parquet`), sorted by time. Its columns
  are `ts` (naive US/Eastern wall-clock time), `timestamp` (the same wall-clock time in microseconds), `open`,
  `high`, `low` and `close` (float32, split-adjusted), `volume` (float64), `symbol_id` and `asset_class_id`.
  Bars run from 04:00 to 19:59. Reads are partitioned by symbol through the file list, and by date through
  each file's row-group statistics. BFD's own Polars-GPU and cuDF loaders expect this layout, so the same
  bytes serve them unchanged.
- **The canonical layout** is what `synthetic-market` writes, and what a new real dataset should use:

  ```text
  <dataset>/
    manifest.json
    bars/month=YYYY-MM/part-NNN.parquet   symbol, time, open, high, low, close, volume; sorted by (symbol, time),
                                          row groups of about 122,880 rows, parts of at most about 256 MB
    companies.parquet                     symbol, company_name, sector, industry, sic_code, exchange, profile,
                                          is_synthetic
    news.parquet                          news_id, symbol, published_at (UTC), source_name, headline, summary,
                                          event_type, sentiment_label, is_story
  ```

  The data is partitioned by date: a month directory prunes a date window. Within each file it is clustered
  by symbol: row-group minimum and maximum values prune symbols. One file per symbol per day would create
  too many small files.

**The build keeps v1's table layout:** one `tables/<table>.parquet` per table, sorted by its natural key, with
row groups. Small dimension tables are loaded into DuckDB with their keys, as in v1. Tables marked
`storage: parquet` (`daily_prices`, `company_news`) become views instead:

```sql
CREATE VIEW main.daily_prices AS SELECT * FROM read_parquet('/data/builds/<build>/tables/daily_prices.parquet');
```

The path is absolute because DuckDB resolves relative paths from the reader's working directory. Every
reader already mounts the volume at `/data`. The raw minute bars never enter the DuckDB file. Only the
rollup and the optional intraday tool read them.

## Import

### The daily rollup

This is one DuckDB statement over the bars, read in place. It streams, and it spills to
`/data/cache/tmp` under `DATA_DUCKDB_MEMORY` (default: half the container's memory).

```sql
SELECT symbol, CAST(time AS DATE) AS trading_date,
       arg_min(open, time) AS open, max(high) AS high, min(low) AS low, arg_max(close, time) AS close,
       sum(volume) AS volume, sum(close * volume) AS dollar_volume, count(*) AS bar_count
FROM bars                                   -- read_parquet(files, filename = true) with the mapping applied
WHERE CAST(time AS TIME) BETWEEN TIME '09:30' AND TIME '16:00'
GROUP BY ALL ORDER BY symbol, trading_date
```

- The session ends at 16:00 inclusive. In `bfdmini` the 16:00 bar carries the closing auction: for AAPL
  on 2026-03-11 it holds 5.65 million shares, against 0.58 million at 15:59 and 2,025 at 16:01.
- On early-close days (for example 2025-11-28 and 2025-12-24), after-hours bars up to 16:00 are counted
  as regular. This is a known approximation; there is no holiday calendar.
- Daily bars (`frequency: 1d`) pass through unchanged.
- Measured on `bfdmini`: the pass reads all 117,242,458 bars and keeps 106,348,392 regular-session bars. It
  writes 572,995 daily rows (2,200 symbols, 305 dates) to a 16.6 MB file in 1.5 s on a 14-core laptop.
  At 100 times the size, expect minutes, once.

**The cache is keyed by the manifest digest.** The key is
`sha256(dataset fingerprint ‖ canonical JSON of market.bars ‖ ROLLUP_VERSION)`. The rollup is written to
`/data/cache/rollups/<key16>/daily_bars.parquet`, with a `rollup.json` beside it recording the inputs, the
row and symbol counts, the date range and the duration. Builds share it: changing the questions, the
exclusions or the SEC snapshot starts a new build but reuses the rollup. `demo-data clean` removes rollups
that no build references, and `clean --all` removes every rollup.

### Tables

The importer turns the rollup, the companies and the news into the fixed table set:

| Table | Rows (`us-equities` on `bfdmini`, approx.) | Built from |
|---|---|---|
| `trading_sessions` | 298 | Dates on which at least half the symbols have a regular-session bar. This drops holidays: on 2025-01-09, 2025-01-20, 2025-05-26 and 2025-06-19 only 2 symbols have bars. The result, 298 sessions, matches the exchange calendar. |
| `assets` | at most 1,818 (before the SEC match) | The symbols left after exclusion, plus company metadata, `liquidity_rank` (median daily dollar volume, over the sessions before the prediction anchor) and `is_synthetic` |
| `ticker_history` | one per asset | One row per asset: its current ticker, from its first session. Past ticker changes are not in the data. |
| `daily_prices` | at most 498,845 (before the SEC match) | The rollup on sessions, for kept symbols: `price_id`, `open`, `high`, `low`, `close`, `adjusted_close` (equal to `close`: the bars are split-adjusted, dividends are not), `volume`, `dollar_volume`, `bar_count`, `total_return_1d` |
| `asset_relationships` | at most 8 per asset | Declared peers: the 8 most liquid assets with the same 4-digit SIC code (`synthetic-market`: the generator's peers) |
| `company_news` | `synthetic-market` only | The dataset's `news.parquet` |

`asset_id` is the ticker as the data spells it, for example `NVDA` or `BRK.B`. The same `schema.sql` serves
both packs.

**Exclusions** are applied in order. Each reason is counted in `pack.json` under `import.dropped`.

1. `preferred`: a symbol containing `.` is dropped, unless the SEC ticker list has it with `-` (so
   `BRK.B` stays and `ABR.D` goes).
2. `warrants`, `units`, `rights`: `X` plus `W` or `WS`, `U`, `R` or `RT`, where `X` is also a symbol.
3. The symbol is not in the SEC ticker list (ETFs, funds, delisted issuers).
4. It has fewer than `min_sessions` daily bars.

On `bfdmini`, rules 1 and 2 drop 367 of the 2,200 symbols (130 dotted, 109 warrants, 59 units and 69
rights). Rule 4 drops 15 more, leaving 1,818 symbols and 498,845 daily rows before rule 3.

**SEC company metadata** (`companies: sec`) comes from `company_tickers_exchange.json` (CIK, name, ticker,
exchange) and each CIK's `submissions/CIK##########.json` (`sic`, `sicDescription`). SEC allows 10
requests a second, so about 1,800 CIKs take roughly 3 minutes the first time. Both need `SEC_USER_AGENT`.
Sector is the SIC division (for example 20–39 Manufacturing, 60–67 Finance); industry is the SIC description.
The files are cached under `/data/cache/sec/<date>/`, and `prepare` reuses the newest snapshot unless run with
`--refresh-sec`. The snapshot's digest is part of the build key, and its date is recorded in `provenance`.

## Document sources

| Source | Packs | Format | Notes |
|---|---|---|---|
| `sec_filings` | both | `edgar-filings` (unchanged) | `synthetic-market` reuses the pinned 2026 Q2 manifest (1,000 8-K and 6-K filings). `us-equities` gets its own pinned manifest, selected by a committed script from the pack's issuers over 2025-01-01 to 2026-03-31: the latest 8-Ks of the 150 most liquid issuers, plus every 8-K by any pack issuer that EDGAR full-text search returns for "Item 1.05", capped at 1,500. |
| `market_regulations` | both | `ecfr-xml` (unchanged) | eCFR Title 17 as of 2026-08-17. |
| `world_news` | `us-equities` | `gdelt-parquet` (new), `opt_in: true` | Read in place from the external dataset (`gdelt/*.parquet`, 8,192 headlines, 2025-01-01 to 2026-02-02). One document per headline: `document_id` is `gdelt:<id>`; `title` and `text` are the headline; `url`; `published_at` comes from `date` (`YYYYMMDDHHMMSS`, UTC); `metadata` holds the source domain, `tone` and `cluster_label`. The precomputed `embedding` column is ignored, so every document is embedded by the retriever's model. |

In `us-equities`, filings and prices describe the same companies. The agent connects them by issuer name
across two sources, which is the point of keeping filings separate. In `synthetic-market`, the issuers are
fictional and the filers are real, and questions keep that boundary explicit, as they do today.

**Indexing is batched and resumable.** Today an interrupted index is dropped and rebuilt. Instead,
`retrieval-index` writes to a staging collection named after the corpus digest, lists the chunk ids already
in it, and embeds only the rest, in batches of 50. The collection is renamed only when it is complete.

## Tool contract and GPU reads

**The contract changes in one place:** the news table becomes optional. It stays `market-analytics/v1`,
because no column changes.

- `analytics.news_table` may be `null`. `$news_table` is then not required, and `validate` does not look
  for it.
- With no news table, the worker holds an empty news frame with the contract's columns, and skips the news
  call in its warm-up. `sentiment_timeline` and `analyze_news_price_relationship` stay registered, so the
  tool registry, the OpenShell policy and the UI are unchanged. They return `status: "failed"` with
  `error.code: "news_unavailable"` and the message "The active data pack has no ticker-linked news table,
  so this tool is unavailable. Use retrieve_evidence for filings and other documents." Their MCP
  descriptions start with "Unavailable in the active data pack.", and the market skill says not to retry.
- The receipt's error code is an open identifier, so the API and the generated contracts do not change.
- `session_close_utc` stays a fixed UTC time. `us-equities` uses 21:00, which is the eastern-standard-time
  close, so bar timestamps are an hour late while daylight saving time is in effect. Without a news table,
  that shifts only the displayed timestamps. A pack that pairs real news with real prices will need a
  per-row `close_at`; that is a contract change, not made now.

**GPU reads come in two tiers.**

| Data | How it is read | Where the memory goes |
|---|---|---|
| Daily tables (the six market tools) | Loaded once into the worker at startup, as today: only the needed columns, and timestamps normalized to naive UTC. | About 100 bytes per daily row across the worker's frames, and a few times that at peak while deriving them. 10,000 symbols over 10 years (about 25 million rows) needs a few GB of an A100's 40 GB. The GPU service sets `CUDF_PANDAS_RMM_MODE=managed_pool`, so a larger pack pages to host memory instead of failing. At startup the worker logs the estimate from the Parquet metadata. |
| Minute bars (the optional intraday tool; never the six daily tools) | Partition-scoped per request. The symbols map to files (one per symbol) or to month directories (canonical); the window becomes Parquet row-group filters. The files are read in batches whose estimated uncompressed size stays under `ANALYTICS_GPU_BATCH_BYTES` (default 2 GiB). Each batch is reduced to its per-symbol result before the next is read. | One batch at a time, whatever the dataset's size. Requests are bounded (for example 50 symbols × 30 sessions). |

The full minute set is scanned only by the rollup, which runs in DuckDB on the CPU, streams, and is cached.
There is no GPU rollup: 1.5 s on `bfdmini` does not justify one. The tools stay on pandas code run by
cudf.pandas, and Polars is not added. Datasets use BFD's layout, so BFD's Polars-GPU benchmarks run on the
same files.

At `bfdmini`'s daily size (about 500,000 rows), GPU margins will be smaller than the 1.5 to 8.1 times
measured at 1.36 million rows. `synthetic-market`'s `standard` profile keeps that scale, and the minute tier
is where `us-equities` can show GPU work.

## The Data Designer pack

### Verified on 2026-09-29

- `data-designer` 0.9.3 (released 2026-09-21) is the current release. It installs `data-designer-config`
  and `data-designer-engine` 0.9.3 and needs Python 3.10 or later.
- The API: `DataDesigner(model_providers=[...]).create(builder, num_records=, resume=ResumeMode.IF_POSSIBLE)`,
  `DataDesignerConfigBuilder(model_configs=[...])`, `with_seed_dataset(DataFrameSeedSource(df=...),
  sampling_strategy=SamplingStrategy.ORDERED)`, `LLMStructuredColumnConfig(output_format=<Pydantic model>)`,
  `LLMTextColumnConfig`, `ExpressionColumnConfig` and `CustomColumnConfig`.
- **Sampler columns cannot be seeded.** The engine builds each sampler's generator with `random_state=None`,
  and no configuration reaches it. Seeded numbers therefore come from our code, not from Data Designer's
  samplers (below).
- **`api_key` is an environment variable name**, resolved when a request is made. The built-in `nvidia`
  provider reads `NVIDIA_API_KEY`, which this repository never uses. So the pack defines its own provider:
  `ModelProvider(name="build", endpoint=DATA_DESIGNER_BASE_URL, provider_type="openai",
  api_key="DATA_DESIGNER_API_KEY")`.
- **Dependencies conflict with the data project:** 0.9.3 needs `pyarrow>=24,<25`, and `demo-data` pins
  `pyarrow==25.0.1`. Generation therefore gets its own uv project and image (below).
- **A live preview** on build.nvidia.com with the nvapi key worked, once the model timeout was raised to
  120 s (the default health check timed out):
  - Plain text on `nvidia/nemotron-3.5-lightning-30b-a3b` produced one degenerate name out of three.
  - A structured column on `nvidia/nemotron-3-super-120b-a12b` with thinking off gave clean names and
    profiles.
  - In both, names repeated across rows: 4 of 6 structured rows were duplicates.
  - The design below answers each of these.

### Two stages

| | `demo.sh data generate [--profile P]` | `demo.sh data prepare` |
|---|---|---|
| Runs | Rarely: to change the text, or for a profile larger than the committed text | Every build |
| Code | `data/generate/`: its own uv project, with `data-designer==0.9.3`, and image `market-demo/data-generate:local` (profile `tools`) | `data/packs/synthetic-market/generator/` in the data image (numpy and pyarrow; `numpy` is added to `demo-data`) |
| Needs | `DATA_DESIGNER_API_KEY` (defaults to `INFERENCE_API_KEY`), `SEC_USER_AGENT` | Nothing: no key, no network |
| Writes | The **text dataset**: `companies.parquet`, `headline_bank.parquet`, `story_news.parquet`, `checks.json` and a manifest | The raw dataset in the canonical layout, in `/data/cache/generated/<digest16>/`, then the normal import |
| Deterministic | No: LLM output. It is reviewed, then pinned by its manifest digest. | Yes: identical bytes for identical seed, parameters, text and code |

The text for `standard` is committed in `data/packs/synthetic-market/text/`, at a few hundred kilobytes, and
reviewed like any other change; `generate --profile standard` rewrites it there for review. A profile
needing more issuers than the committed text writes its text dataset to
`$DATA_SOURCE_DIR/synthetic-market-text-<profile>/`. `prepare` then uses it, or asks you to run `generate`.
Rosters are prefix-stable, so every smaller profile uses the first N rows of the committed text.

`DATA_DESIGNER_BASE_URL` defaults to `https://integrate.api.nvidia.com/v1`, and `DATA_DESIGNER_MODEL` to
`nvidia/nemotron-3-super-120b-a12b` (thinking off, temperature 0.7, timeout 120 s). Like the other keys, the
key reaches only the one-shot generate container.

### The scale knob

The knob is the generator profiles in `pack.yaml`, selected with `DATA_PACK_PROFILE`. To scale further, add
a profile.

| Profile | Issuers | Dates | Bars | Daily rows | Minute rows | Text |
|---|---|---|---|---|---|---|
| `ci` | 12 (the story issuers) | 2026-06-01 to 2026-08-31 | 1min | about 770 | about 300,000 | committed |
| `interactive` | 50 | 2025-01-02 to 2026-08-31 | 1d | about 21,000 | – | committed |
| `standard` (default) | 2,000 | 2024-01-02 to 2026-08-31 | 1d | about 1.34 million | – | committed |
| `intraday` | 500 | 2026-03-02 to 2026-08-31 | 1min | about 64,000 | about 25 million | committed |
| `large` | 10,000 | 2016-01-04 to 2026-08-31 | 1d | about 27 million | – | `data generate` |

The committed text lives in `text/`, so the `.parquet` guard above allows `data/packs/*/text/`.

### Seeded numbers

Every random draw comes from `np.random.default_rng([pack_seed, crc32(stream), *keys])`, with one named
stream per concern (`roster`, `market`, `sector`, `issuer/<slot>`, `news/<slot>`, `story`). Because the keys
are per issuer slot, a profile's first N issuers are identical in every profile, and adding issuers changes
no existing series.

- **Roster** (the seed dataset handed to Data Designer): `slot`, a pronounceable invented `name_root`, a
  `ticker`, `sector`, `industry`, a real `sic_code` for that industry, `exchange`, and `is_story` for slots 0
  to 11. Price-model parameters: start price, drift, volatility, and betas to the market and the sector.
- **Returns**: `r[i,t] = β_i·market_t + γ_i·sector_{s,t} + σ_i·ε[i,t] + shock[i,t]`. Each factor and ε
  is Student-t with 4 degrees of freedom, scaled to its target volatility, over a calendar with the exchange
  holidays for 2016 to 2026. Opens gap from the previous close; highs and lows come from a half-normal
  intraday range.
- **Volume**: log-normal around each issuer's base, rising with |r|/σ, and 2 to 4 times higher on news
  sessions.
- **News**: background events arrive per issuer as a Poisson process (the profile's
  `news_per_issuer_month`), with a type and a sentiment label. The next session's return tilts ±0.3σ with
  the label: a modest, planted relationship that `analyze_news_price_relationship` should find. There are 12
  story events, one per story issuer, published from 2026-08-17 to 2026-08-28, each with a fixed shock of
  ±6 to 12% on its publication session. Oracles check both.
- **Minute bars** (1min profiles): 390 bars per session. Each is a Brownian bridge from the day's open to its
  close, scaled to its high and low, with U-shaped volume. The rollup reproduces the daily bar exactly, and a
  test proves it.
- Model constants live in `generator/model.yaml`, not in code.

### Nemotron text

The roster is passed to Data Designer as an ordered `DataFrameSeedSource`, so each LLM row is tied to one
seeded slot.

| Data Designer job | Records | Column (structured, Pydantic `output_format`) |
|---|---|---|
| `companies` | one per issuer | `company_name` (at most 40 characters, built on `name_root`, no legal suffix) and `profile` (one sentence, at most 300 characters) |
| `headline_bank` | event type × sentiment × 20 variants | `template`: at most 110 characters, with exactly one `{company}` placeholder |
| `story_news` | the 12 story events (issuer, date, type, sentiment, shock) | `headline` (at most 110 characters) and `summary` (at most 600 characters) |

A background news row's headline is a template drawn by its seeded stream and filled with the company name.
The number of LLM calls therefore grows with the issuers, not with the news volume. build.nvidia.com's rate
limit is what bounds `generate`, and `resume=IF_POSSIBLE` lets an interrupted run continue.

### Checks, at generate time

Any failure stops `generate`.

- **Shape.** The Pydantic formats enforce the lengths. A template must have exactly one placeholder.
- **Unique.** Normalized names, tickers and roots must be unique within the pack. Normalizing means
  casefolding, stripping punctuation and dropping legal suffixes: inc, corp, corporation, co, company, ltd,
  plc, holdings, group, llc, lp, sa, nv, ag, trust, the.
- **No real collisions**, checked against SEC's `company_tickers.json`, `company_tickers_exchange.json`
  and `company_tickers_mf.json`, fetched with `SEC_USER_AGENT`:
  - no ticker may be an SEC ticker;
  - no normalized name may equal a normalized SEC title;
  - no `name_root` may appear as a word in any SEC title.
  A slot that fails draws its next root from its own stream, and that slot alone is regenerated, for at most
  5 rounds. So the output is deterministic for a given SEC snapshot.
- **Labels.** `assets.is_synthetic` is true. News `source_name` is "Synthetic Newswire". The source is
  `synthetic: true`, so the UI shows its badge. The pack disclaimer says that the issuers, prices and news are
  fictional.
- **Record.** `checks.json` records the SEC files' URLs, SHA-256 values and fetch time, the counts, the
  rejects per round, the model id, the Data Designer version and the seed.
- The contract tables are validated again at `prepare`, like every pack.

## The CI fixture

The fixture is small, committed and fully synthetic. It holds no rows from any real dataset, and a committed
script regenerates it.

| Fixture | Contents | Tests |
|---|---|---|
| `data/tests/fixtures/external/minute-bars/` (made by `make_minute_bars_fixture.py`, under 200 KB) | 6 made-up symbols in BFD's per-symbol layout: a base, its `W`, `U` and `.P` variants, and 2 others. 3 sessions plus 1 holiday, with bars from 04:00 to 19:59 and a heavy 16:00 bar. A BFD-format manifest, a stub SEC ticker file and stub submissions. | The fingerprint algorithm; fetch from `file://` and rejection of a corrupted copy; rollup values checked by hand (16:00 included, extended hours excluded); the session rule; each exclusion; import, then contract validation; a clear error when a pack's dataset is missing |
| `synthetic-market`, profile `ci` | The committed text plus seeds | An end-to-end `prepare` in seconds with no network, through the minute bars and the rollup (the `slow` marker, as today); rollup exactness; the planted-event oracles |
| `tools/market-analytics/tests/fixture_pack.py` | A variant with `news_table: null` | Both news tools return `news_unavailable`; the other tools are unaffected |

`us-equities` is checked in CI by `validate` only: the schema, cross-references and declared contracts, none
of which needs the data. A live run on real data happens on a GPU VM, with the data fetched there.

## Questions

Each pack has its own `questions.yaml`. Six questions are featured, and all six need only the default
profiles (`core,retrieval,analytics`), so the landing page stays on one screen. Kumo (PREDICTION) and Auto
Ontology (SQL) questions are listed but not featured. Wording is final only after each question has been run
against the built pack. Every analytics question gets an oracle in `eval/oracles/`, and every retrieval
question gets expected document ids in `eval/`.

### `synthetic-market` (as of 2026-08-31; the story universe is the 12 story issuers)

| Id | Tag | Sources | Question (draft) | Tools |
|---|---|---|---|---|
| `market-leaders` ★ | ANALYTICS | `market_data` | Which story issuers had the strongest and weakest returns over the 20 trading sessions ending August 31, 2026, and how did their daily volatility compare? | `market_scan` |
| `news-sentiment-reaction` ★ | ANALYTICS | `market_data` | For company news about the story issuers published August 17–28, 2026, how did the sentiment labels line up with returns over the next five sessions? Describe the relationship without claiming causation. | `sentiment_timeline`, `analyze_news_price_relationship` |
| `unusual-sessions` ★ | ANOMALY | `market_data` | Treat January 2 through June 30, 2026 as the baseline for all issuers. Which 10 sessions from July 1 through August 31 were most unusual in return, volatility and volume, and why? | `market_anomaly_scan` |
| `peer-network` ★ | GRAPH | `market_data` | In the return-correlation network from June through August 2026, which issuers are the most central, and which pairs moved together most closely? | `analyze_market_relationships` |
| `cyber-disclosure-rules` ★ | RETRIEVAL | `sec_filings`, `market_regulations` | What does Form 8-K Item 1.05 require a company to disclose about a material cybersecurity incident, and which 2026 Q2 filings in the corpus report one? | `retrieve_evidence` |
| `news-and-filings` ★ | HYBRID | `market_data`, `sec_filings` | Which story issuers had the most negative company news in July and August 2026, and how did their prices react? Separately, which real Q2 2026 SEC filings describe operational disruptions? Keep the fictional issuers and the real filers apart. | `sentiment_timeline`, `price_context`, `retrieve_evidence` |
| `story-event-context` | ANALYTICS | `market_data` | Price context around each story event | `price_context` |
| `outcome-prediction` | PREDICTION | `market_data` | As of August 24, 2026, which story issuers are most likely to post a positive five-session return? | `predict_asset_outcomes` |
| `sector-sql` | SQL | `market_data` | Company count and median 20-session return by sector | `ask_question` |

### `us-equities` (as of 2026-03-12)

| Id | Tag | Sources | Question (draft) | Tools |
|---|---|---|---|---|
| `market-leaders` ★ | ANALYTICS | `market_data` | Among the 50 most liquid US stocks, which had the strongest and weakest returns over the 20 trading sessions ending March 12, 2026, and how did their daily volatility compare? | `market_scan` |
| `unusual-sessions` ★ | ANOMALY | `market_data` | Using 2025 as the baseline, which 10 sessions from January 2 through March 12, 2026 were most unusual across all stocks in the pack, and which features made them unusual? | `market_anomaly_scan` |
| `peer-network` ★ | GRAPH | `market_data` | Among declared industry peers, which stocks were the most central in the return-correlation network from December 2025 through March 12, 2026, and which pairs moved together most closely? | `analyze_market_relationships` |
| `moves-and-filings` ★ | HYBRID | `market_data`, `sec_filings` | Which of the 50 most liquid stocks had the largest one-day moves in February 2026, and what did those same companies disclose in 8-K filings in those weeks? Report the moves and the filings separately, and do not claim that a filing caused a move. | `market_scan`, `price_context`, `retrieve_evidence` |
| `cyber-disclosure-rules` ★ | RETRIEVAL | `sec_filings`, `market_regulations` | What does Form 8-K Item 1.05 require, and by when? Cite the regulation, and any filings in the corpus that report an incident. | `retrieve_evidence` |
| `large-universe-scan` ★ | ANALYTICS | `market_data` | Across every stock in the pack, which 20 had the strongest and the weakest returns from January 2 to March 12, 2026, and how unusual was their volume? | `market_scan` |
| `outcome-prediction` | PREDICTION | `market_data` | As of March 5, 2026, which of the 50 most liquid stocks are most likely to post a positive five-session return? | `predict_asset_outcomes` |
| `sector-sql` | SQL | `market_data` | Stock count and median return by SIC division, first quarter of 2026 to date | `ask_question` |
| `world-news-rates` | RETRIEVAL | `world_news` (opt-in) | What do the world news headlines in the corpus say about central banks and interest rates? | `retrieve_evidence` |

The universes in `us-equities` are `top_50` (`liquidity_rank <= 50`), `liquid_500` and `all_assets`. The
Kumo population is `top_50`, with the anchor at 2026-03-05 21:00 UTC and a horizon of 5 sessions. With no
news table, the prediction graph has no `news_events` view and no news template. The news tools get no
featured question in `us-equities`.

## Disk

| Item | `bfdmini` | Scales with |
|---|---|---|
| `DATA_SOURCE_DIR/minute-bars` | 1.8 GB | the dataset |
| Rollup cache | 17 MB | about 1% of the minute data |
| A build (tables, DuckDB, ontology) | under 100 MB | the daily rows |
| SEC and eCFR downloads, the Milvus index | about 2 GB | the corpus selection |

`doctor` compares the free space on `DATA_SOURCE_DIR` with the pack's `external.<id>.bytes`, plus 10%.
It reads each dataset's needed variables from `provenance[].requires_env` of the selected pack, instead of
hard-coding `market_news`. On Brev, the images and the Docker volumes stay where they are today
([operations](operations.md#disk)), and only `DATA_SOURCE_DIR` moves to the large disk.

## Where the work lands

| Area | Change |
|---|---|
| `data/schemas/pack.schema.json` | v2: `external`, `market`, provenance kind `external`, `storage`, nullable `news_table`, `population` by view |
| `data/src/demo_data/` | `external.py` (manifest, fingerprint, verification), `fetch.py` (sources), `market.py` (rollup, import), `sec.py`, `corpus/gdelt.py`; `structured.py` (views for `storage: parquet`); `ontology.py` (keys from `pack.yaml` for those views); `cli.py` (`fetch`) |
| `data/generate/` | New uv project: the Data Designer jobs and the checks |
| `data/packs/` | `synthetic-market/` and `us-equities/` are added. `market-analysis/` shrinks to its recordings. |
| `tools/market-analytics/` | The contract note for the optional news table; `data.py` and `server.py` (`news_unavailable`); the warm-up; the fixture |
| `tools/retrieval/` | Resumable indexing |
| `scripts/demo.sh`, `scripts/lib/doctor.sh`, `compose.yaml`, `.env.example` | `data fetch` and `data generate`, the `/sources` mounts, the `DATA_SOURCE_*`, `DATA_DESIGNER_*` and credential variables, pack-driven `requires_env`, the default `DATA_PACK` and `DATA_DATABASE_NAME` |
| `.gitignore`, `.github/workflows/ci.yml` | `data/external/`; the committed-Parquet guard |
