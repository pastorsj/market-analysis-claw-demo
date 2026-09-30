<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Data packs

A data pack is one directory under `data/packs/` that describes a whole demo world: its tables, its document
corpora, the sources the UI and the agent see, the analytics and prediction settings, the demo questions and
the recorded sessions. The `demo-data` builder turns the selected pack into files under `/data` and points
`/data/active` at the result. Services read only `/data/active`, so swapping the data means adding a pack, not
changing code.

The format, the runtime layout and the builder's commands are specified in
[`data/README.md`](../data/README.md). How external data is fetched, imported and scaled is in
[data platform](data-platform.md). This page is the guide.

## The packs

The repository ships two packs in one format: the same tables, built by the same importer from a raw market
dataset. In both, SEC EDGAR filings are a separate document source, searched by retrieval. They are never
converted into news events or written to a news table: the demo shows the agent combining a price database and
a document corpus, each through its own tool.

| | [`synthetic-market`](../data/packs/synthetic-market/README.md) (default) | [`us-equities`](../data/packs/us-equities/README.md) (optional) |
|---|---|---|
| Prices | Fictional issuers (2,000 at the default `standard` profile), seeded prices; one-minute bars in the `ci` and `intraday` profiles | About 1,600 real US stocks, January 2025 to March 2026, rolled up from real one-minute bars that stay outside the repository |
| Company data | Names and profiles written by Nemotron with NeMo Data Designer, checked against SEC's ticker lists | SEC names, CIKs and SIC codes |
| Ticker-linked news | `company_news`: seeded events with Nemotron headlines, and 12 planted stories | None: `sentiment_timeline` and `analyze_news_price_relationship` report that they are unavailable |
| `sec_filings` | 1,000 real 8-K and 6-K filings from 2026 Q2, by any filer (the issuers are fictional) | 1,074 8-Ks filed by the pack's own companies over its price window |
| Other documents | `market_regulations`: eCFR Title 17 | `market_regulations`, and `world_news`: 8,192 GDELT headlines (opt-in) |
| Needs | Nothing for the structured part; `SEC_USER_AGENT` for `sec_filings` | `demo.sh data fetch` first; `SEC_USER_AGENT` for company data and `sec_filings` |

The synthetic market has planted facts, so answers can be checked: `eval/oracles/*.sql` computes them from a
build. The downloaded documents are fetched at build time from pinned URLs and checked against their SHA-256;
they are never committed. `us-equities`' data reaches a machine through a fetch step:

```bash
# .env: DATA_PACK=us-equities, and DATA_SOURCE_MINUTE_BARS=<a directory, host:/path or URL>
./scripts/demo.sh data fetch          # into $DATA_SOURCE_DIR/minute-bars, verified against the pinned manifest
./scripts/demo.sh data prepare
```

## How a pack is built

```text
./scripts/demo.sh up                  # runs the data one-shots as dependencies
./scripts/demo.sh data prepare        # rebuild after changing the pack or its settings
```

| Step | Service | Writes |
|---|---|---|
| Structured part | `data` (core) | `tables/*.parquet`, `structured/<database>.duckdb`, `ontology/model.yaml`, `prediction/`, `pack.json` |
| Corpus | `data-corpus` (retrieval) | `corpus/documents.jsonl` |
| Index | `retrieval-index` (retrieval) | the Milvus collection and `collection-manifest.json` |

Each build lives in `/data/builds/<pack>@<version>+<profile>+<digest>`. The digest covers the pack's files
(not its `README.md`, `eval/`, `recordings/` or `tests/`), the profile, the selected corpora and the builder
itself, so preparing an unchanged pack is a no-op and any change starts a new build. `/data/active` switches
atomically. `data prepare` also restarts market analytics and retrieval, which keep the build they resolved at
startup; switching `DATA_PACK` and running `up` restarts them too.

`pack.json` in the build is what services read: the sources and questions this build can serve, the database
name and paths, the analytics and prediction settings, the minute bars' location, and the digests of every file.

Settings (`.env`, [configuration](configuration.md#4-data-pack)): `DATA_PACK`, `DATA_PACK_PROFILE`,
`DATA_CORPORA` and `SEC_USER_AGENT`. An empty `DATA_CORPORA` builds every corpus the pack does not mark `opt_in`:
`sec_filings` and `market_regulations` in both packs. Add `world_news` to build the GDELT headlines of
`us-equities`.

Other commands, all run in the data image:

```bash
./scripts/demo.sh data validate       # the pack's schema, cross-references and tool contracts
./scripts/demo.sh data verify         # the active build still matches the digests in its pack.json
./scripts/demo.sh data list           # packs and builds
./scripts/demo.sh data clean [--all]  # remove inactive builds and unused caches (--all: every cache)
./scripts/demo.sh data fetch          # fetch and verify the pack's external datasets
./scripts/demo.sh data generate       # write synthetic-market's Nemotron text (rarely; needs a key)
./scripts/demo.sh data reindex        # rebuild only the retrieval index
```

## Sources, capabilities and questions

Each source in `pack.yaml` declares its `capabilities`, which are tool families from
`contracts/tool-registry.json`: `unstructured_retrieval`, `market_analytics`, `structured_retrieval`,
`structured_prediction`. The API offers a source with only the capabilities the running tools provide, and a
job's selected sources decide which tools the agent gets. For example, `market_data` offers
`structured_retrieval` only when the ontology profile runs.

A tool whose data a pack lacks stays registered, so the registry, the sandbox policy and the UI never change with
the pack. Its MCP description starts with "Unavailable in the active data pack", and a call fails at once with
`news_unavailable` (no ticker-linked news table) or `minute_bars_unavailable` (no minute bars, as in
`synthetic-market`'s daily-bar profiles). The market skill tells the agent not to call it.

`questions.yaml` holds each pack's demo questions. A question is offered only when every source it names is in
the build and, if it lists `profiles`, the build uses one of them. Six are `featured` in each pack: they need
only the default profiles, fit the landing page on one screen, and are what `record` asks by default. Every
analytics question has an oracle in `eval/oracles/`, and `eval/retrieval.yaml` names the documents a retrieval
answer should cite.

## Recordings

The replay bundle lives with its pack, in `data/packs/<pack>/recordings/`, and is committed. It is written by:

```bash
./scripts/demo.sh record                          # the featured questions
./scripts/demo.sh record --all                    # every question the build offers
./scripts/demo.sh record --question market-leaders --question peer-network
```

`record` asks each question on the running stack, one at a time, and rewrites `index.json` with only the
sessions it recorded, so `--question` makes a bundle of just those questions. A question that does not succeed
is left out, and the command exits 1. Review the files before committing: they hold questions, answers, evidence
excerpts and model names. `./scripts/demo.sh replay` then serves the UI on the bundle alone, and stops with a
hint when the pack has none. The format is in [`api/README.md`](../api/README.md#recordings).

The current packs are not recorded yet. The committed bundle is the one recorded for the pack they replaced,
`market-analysis` (a generated market of 12 fictional issuers), which is otherwise gone:

```bash
DATA_PACK=market-analysis ./scripts/demo.sh replay
```

It holds five sessions, recorded on 2026-09-29 with the `.env.example` models (Nemotron 3 Ultra alone, on
build.nvidia.com) and every profile, including `ontology` and the local Kumo NIM, on a Brev A100 VM. Ultra's
known faults show in it, and the bundle keeps them rather than hiding them ([models and
routing](models-and-routing.md#the-default-on-buildnvidiacom)). In it, `market_news` names the SEC filings, a
document source like `sec_filings` today.

## Adding or swapping a pack

1. Copy `data/packs/us-equities` (bars you fetch) or `data/packs/synthetic-market` (a generator) to
   `data/packs/<new-id>`. For your own bars, pin their dataset under `external` and describe their layout under
   `market.bars` ([data platform](data-platform.md)).
2. Edit `pack.yaml` (identity, licenses, provenance, sources, disclaimer, analytics universes, prediction),
   `schema.sql`, `ontology.yaml` and `questions.yaml`. Only the columns in the tool contracts are mandatory.
3. Set `DATA_PACK=<new-id>` in `.env`, then run `./scripts/demo.sh data validate` and
   `./scripts/demo.sh data prepare`. Record its sessions with `./scripts/demo.sh record`.

No code changes are needed while the pack satisfies the contracts its tools own. Market analytics requires what
`tools/market-analytics/contract/market-analytics.v1.json` lists (a pack declares
`analytics.contract: market-analytics/v1`); `validate` checks the declared schema and `prepare` checks the
built tables. The database name is the pack id in snake case.

## Licenses

- The synthetic market data and its Nemotron-written text are Apache-2.0.
- `us-equities`' minute bars and GDELT headlines are a private dataset, used as provided and never committed or
  redistributed here.
- eCFR is United States government public information. The eCFR is authoritative but is not the official legal
  edition of the CFR.
- SEC EDGAR content falls under the SEC's website reuse terms, and issuer-authored content may carry its own
  rights; its redistribution terms are unknown. The filings are fetched at build time and never committed.
