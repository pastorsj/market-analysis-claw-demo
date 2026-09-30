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
[`data/README.md`](../data/README.md). This page is the guide.

## The market-analysis pack

The repository ships one pack, [`market-analysis`](../data/packs/market-analysis/README.md): a deterministic
synthetic market beside real public documents.

| Source | Kind | Origin | Contents |
|---|---|---|---|
| `market_analysis_structured` | structured | generated, synthetic | Prices, events, corporate actions, peers and short-form news for 12 fictional issuers (plus 1,988 more in the `qualification` profile) in DuckDB and Parquet, and leakage-safe prediction views |
| `market_news` | documents | downloaded, real | SEC EDGAR 8-K and 6-K filings from 2026 Q2 (1,000 pinned filings) |
| `market_regulations` | documents | downloaded, real | eCFR Title 17 as of 2026-08-17 |
| `market_briefs` | documents | committed, synthetic | Eight fictional briefs, one per planted event |

The synthetic market has planted facts (eight news events that move prices, a stock split, dividends, a
prediction anchor) so answers can be checked; `eval/oracles/*.sql` computes them. The downloaded documents are
fetched at build time from pinned URLs and checked against their SHA-256; they are never committed.

## The us-equities pack

[`us-equities`](../data/packs/us-equities/README.md) holds real prices: daily bars for about 1,600 US-listed
stocks, rolled up from real split-adjusted one-minute bars, with SEC company names, CIKs and SIC codes. The bars
are an external dataset that is never committed; fetch them before the first `prepare`:

```bash
# .env: DATA_PACK=us-equities, and DATA_SOURCE_MINUTE_BARS=<a directory, host:/path or URL>
./scripts/demo.sh data fetch          # into $DATA_SOURCE_DIR/minute-bars, verified against the pinned manifest
./scripts/demo.sh data prepare
```

SEC EDGAR filings and eCFR Title 17 are its document sources, separate from the prices. The pack has no
ticker-linked news, so the two news tools report that they are unavailable. How the data is fetched, verified,
rolled up and imported, and how it scales, is in [data platform](data-platform.md).

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
atomically. `data prepare` also restarts market analytics, which keeps the build it resolved at startup.

`pack.json` in the build is what services read: the sources and questions this build can serve, the database
name and paths, the analytics and prediction settings, and the digests of every file.

Settings (`.env`, [configuration](configuration.md#4-data-pack)): `DATA_PACK`, `DATA_PACK_PROFILE`
(`qualification` or `interactive`), `DATA_CORPORA` and `SEC_USER_AGENT`. An empty `DATA_CORPORA` builds every
corpus the pack does not mark `opt_in`: for `market-analysis`, all three.

Other commands, all run in the data image:

```bash
./scripts/demo.sh data validate       # the pack's schema, cross-references and tool contracts
./scripts/demo.sh data verify         # the active build still matches the digests in its pack.json
./scripts/demo.sh data list           # packs and builds
./scripts/demo.sh data clean [--all]  # remove inactive builds and unused caches (--all: every cache)
./scripts/demo.sh data fetch          # fetch and verify the pack's external datasets
./scripts/demo.sh data reindex        # rebuild only the retrieval index
```

## Sources, capabilities and questions

Each source in `pack.yaml` declares its `capabilities`, which are tool families from
`contracts/tool-registry.json`: `unstructured_retrieval`, `market_analytics`, `structured_retrieval`,
`structured_prediction`. The API offers a source with only the capabilities the running tools provide, and a
job's selected sources decide which tools the agent gets. For example, `market_analysis_structured` offers
`structured_retrieval` only when the ontology profile runs.

`questions.yaml` holds the demo questions. A question is offered only when every source it names is in the
build and, if it lists `profiles`, the build uses one of them. `featured` questions are on the landing page
and are what `record` asks by default.

## Recordings

The replay bundle lives with its pack, in `data/packs/<pack>/recordings/`, and is committed. It is written by:

```bash
./scripts/demo.sh record                          # the featured questions
./scripts/demo.sh record --all                    # every question the build offers
./scripts/demo.sh record --question market-leaders --question market-peer-network
```

`record` asks each question on the running stack, one at a time, and rewrites `index.json` with only the
sessions it recorded, so `--question` makes a bundle of just those questions. A question that does not succeed
is left out, and the command exits 1. Review the files before
committing: they hold questions, answers, evidence excerpts and model names. `./scripts/demo.sh replay` then
serves the UI on the bundle alone. The format is in [`api/README.md`](../api/README.md#recordings).

The committed market-analysis bundle holds the six featured questions, recorded on 2026-09-29 with the
`.env.example` models (Nemotron 3 Ultra alone, on build.nvidia.com) and every profile, including `ontology`
and the local Kumo NIM, on a Brev A100 VM. It took two `record` runs on the same commit: the "Event Reaction"
and "Large-Universe Scan" sessions come from a second run that asked just those two again. Ultra's known
faults show in it, and the bundle keeps them rather than hiding them ([models and
routing](models-and-routing.md#the-default-on-buildnvidiacom)).

## Adding or swapping a pack

1. Copy `data/packs/market-analysis` to `data/packs/<new-id>`. Replace the generator, or delete it and commit
   small Parquet tables under a `committed` origin.
2. Edit `pack.yaml` (identity, licenses, provenance, sources, disclaimer, analytics universes, prediction),
   `schema.sql`, `ontology.yaml` and `questions.yaml`. Only the columns in the tool contracts are mandatory.
3. Set `DATA_PACK=<new-id>` in `.env`, then run `./scripts/demo.sh data validate` and
   `./scripts/demo.sh data prepare`. Record its sessions with `./scripts/demo.sh record`.

No code changes are needed while the pack satisfies the contracts its tools own. Market analytics requires what
`tools/market-analytics/contract/market-analytics.v1.json` lists (a pack declares
`analytics.contract: market-analytics/v1`); `validate` checks the declared schema and `prepare` checks the
built tables. The database name is the pack id in snake case.

## Licenses

- The synthetic data and briefs are Apache-2.0.
- eCFR is United States government public information. The eCFR is authoritative but is not the official legal
  edition of the CFR.
- SEC EDGAR content falls under the SEC's website reuse terms, and issuer-authored content may carry its own
  rights; its redistribution terms are unknown. The filings are fetched at build time and never committed.
  The committed recordings cite only eCFR sections and the fictional briefs.
