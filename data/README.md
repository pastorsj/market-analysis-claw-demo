# data

Data packs, and `demo-data`, the builder that turns the selected pack into files the services read.

A **pack** is one directory under `packs/` that describes a whole demo world: its tables, its document corpora, the
source catalog the UI and agent see, analytics and prediction settings, and the demo questions. `demo-data` builds
the pack named by `DATA_PACK` into `/data` and points `/data/active` at the result. Services never read `packs/`;
they read only `/data/active`, so swapping data means adding a pack, not editing code.

The repository ships one pack, [`market-analysis`](packs/market-analysis/README.md).

## How it fits

| Who | When | Reads | Writes |
|---|---|---|---|
| `data` one-shot (profile `core`) | before the API starts | `packs/$DATA_PACK` | the structured part, `pack.json`, `/data/active` |
| `data-corpus` one-shot (profile `retrieval`) | after `data` | `packs/$DATA_PACK`, pinned public files | `corpus/documents.jsonl`, `pack.json` |
| `retrieval-index` one-shot | after `data-corpus` | `corpus/documents.jsonl` | `collection-manifest.json` |
| `api` | runtime | `pack.json` (sources, questions, disclaimer), the DuckDB file (read-only) | – |
| `market-analytics` | runtime | `pack.json` (`analytics`, `prediction`), `tables/*.parquet`, the DuckDB file | – |
| Auto Ontology | runtime | the DuckDB file, `ontology/model.yaml` | – |

All of them share the `demo-data` volume, mounted at `/data`.

## Runtime layout

```
/data/
  active -> builds/<pack>@<version>+<profile>+<digest12>    swapped atomically; readers use only this path
  builds/<build>/
    pack.json                          the pack as this build serves it (below)
    tables/<table>.parquet             every table, including ones kept out of DuckDB
    structured/<database_name>.duckdb  schema.sql + tables + rendered views (e.g. prediction.*)
    ontology/model.yaml                Auto Ontology model, derived from the database and ontology.yaml
    prediction/graph.json              prediction views, keys, time columns, anchor, population, row counts
    prediction/templates.json          PQL templates
    corpus/documents.jsonl             one whole document per line (schemas/documents.schema.json)
    collection-manifest.json           written by retrieval-index, not by demo-data
  downloads/sha256/<digest>            pinned public files, fetched once and shared by every build
```

A build's name ends in a digest of everything it depends on: the pack's files (not `README.md`, `eval/`,
`recordings/` or `tests/`), the profile, the selected corpora and the builder itself. Preparing an unchanged pack is
a no-op; changing any input starts a new build, and the old one stays until `demo-data clean`.

`pack.json` holds the resolved pack: `id`, `version`, `title`, `disclaimer`, `profile`, `licenses`, `provenance`,
the `sources` and `questions` this build can serve (a question needs all its sources and, if it names profiles, one
of them), `structured` (`database_name`, the database path, each table's Parquet path), `analytics` (universes and
graph mode resolved for the profile), `prediction`, `documents` (collection, sources, path) and `parts`: the row and
document counts and the SHA-256 of every file each part wrote. A build becomes active once its structured part is
recorded; the corpus part can be added to it later. Until then, `pack.json` has no `documents` and lists neither the
document sources nor the questions that need them.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATA_PACK` | `market-analysis` | the pack to build, a directory under `packs/` |
| `DATA_PACK_PROFILE` | the pack's `default_profile` (`qualification`) | generator profile |
| `DATA_CORPORA` | every corpus not marked `opt_in` | comma-separated corpus sources, e.g. `market_regulations` |
| `SEC_USER_AGENT` | – | required to fetch SEC EDGAR (`market_news`): a name and an email, e.g. `Example Co admin@example.com` |
| `DATA_DIR` | `/data` | where builds live |
| `DATA_PACKS_DIR` | `data/packs` | where packs live |
| `DATA_CONTRACTS_DIR` | `tools/*/contract/` | the tool contracts to check packs against |

`DATA_PACK_PROFILE` and `DATA_CORPORA` are part of the build key, so they must be identical for the `data` and
`data-corpus` one-shots. Otherwise `prepare --corpus` lands in a build with no structured part, and exits 1.

The database name is the pack id in snake case (`market-analysis` → `market_analysis`), and `validate` enforces it.
Services that read `/data/active/pack.json` should take it from `structured.database_name`. For the others,
`scripts/demo.sh` (bash) exports `DATA_DATABASE_NAME="${DATA_PACK//-/_}"`, and `compose.yaml` uses
`${DATA_DATABASE_NAME:-market_analysis}`, since Compose interpolation has no pattern substitution. A raw
`docker compose up` without `demo.sh` therefore gets the default pack's `market_analysis`, whatever `DATA_PACK` says,
unless `DATA_DATABASE_NAME` is set as well.

## Commands

```bash
demo-data validate                # schema, cross-references, and the tool contracts the pack declares
demo-data prepare                 # build (or reuse) the structured part and the corpus, then activate
demo-data prepare --structured    # tables, DuckDB, ontology, prediction (about 20 s at qualification scale)
demo-data prepare --corpus        # corpus/documents.jsonl (the first EDGAR run downloads about 1.4 GB)
demo-data verify                  # the active build still matches the digests in its pack.json
demo-data list                    # packs and builds
demo-data clean [--all]           # remove inactive builds (--all: also the download cache)
```

## The pack format

`pack.yaml` follows [`schemas/pack.schema.json`](schemas/pack.schema.json); its paths are relative to the pack.

- **Identity**: `id`, `version` (minor for data changes, major for table or column changes), `title`, `description`,
  `as_of`, `disclaimer`, `licenses`, and `provenance`: every origin (`generated`, `committed` or `download`) with
  the environment variables that fetching it needs.
- **`generator`**: a pack-local program, run as `python <entrypoint> --profile <p> --out <dir>`, that writes
  `<dir>/<table>.parquet` for every generated table. `profiles` hold its parameters and the row counts each profile
  must produce.
- **`structured`**: the source it serves, `database_name`, `schema` (DDL with primary and foreign keys), `views`
  (SQL run after loading, with `{{anchor_date}}`, `{{anchor_timestamp}}`, `{{horizon_sessions}}` and
  `{{population_literals}}` filled from `prediction`) and `tables` (`load_into_database: false` keeps a table out of
  DuckDB). Tables load by column name, so Parquet column order does not matter.
- **`documents`**: the collection name and `corpora`, each with a `format` (`markdown`, `ecfr-xml`, `edgar-filings`)
  and a `manifest` that pins what to build. An `opt_in` corpus is built only when `DATA_CORPORA` names it.
- **`sources`**: the catalog: `name` and `description` for the UI, `agent_description` for the agent.
- **`analytics`**, **`prediction`**: settings for the market-analytics and prediction tools.
- **`ontology`**: table and column descriptions. **`questions`**: the demo questions
  ([`schemas/questions.schema.json`](schemas/questions.schema.json)).

Tools own their contracts. A pack that sets `analytics.contract: market-analytics/v1` must provide what
`tools/market-analytics/contract/market-analytics.v1.json` lists. `validate` checks the tables `schema.sql`
declares; `prepare` checks the built tables, including enumerations and unique keys. `demo-data` never imports tool
code.

## Adding or swapping a pack

1. Copy `packs/market-analysis` to `packs/<new-id>`. Replace the generator, or delete it and commit small
   `tables/<table>.parquet` files under a `committed` origin.
2. Edit `pack.yaml` (provenance, licenses, sources, disclaimer, universes, prediction), `schema.sql`,
   `ontology.yaml` and `questions.yaml`. Only the columns in the tool contracts are mandatory.
3. Run `DATA_PACK=<new-id> demo-data validate`, then `prepare`. No code changes are needed while the contracts hold.

## DuckDB versions

An older DuckDB cannot always open a file a newer one wrote, so the writer here must never be newer than the readers
(api, market-analytics, Auto Ontology). `duckdb` is pinned to the readers' version, `structured.py` pins the file's
storage format, and `tests/test_duckdb_versions.py` fails if another uv project in the repository locks an older
DuckDB. Upgrade the readers first, then this pin.

## Development

```bash
cd data
uv sync
uv run pytest                          # fast and offline
uv run pytest -m slow                  # builds market-analysis (interactive) end to end in a few seconds
uv run pytest -m live                  # checks the pinned public sources are still served (network)
uv run demo-data --data-dir /tmp/demo-data prepare --profile interactive --corpora market_regulations
docker build -f Dockerfile -t market-demo/demo-data:dev ..   # the build context is the repository root
```
