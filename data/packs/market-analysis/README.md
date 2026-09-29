# market-analysis pack

A fictional market with real public documents beside it: a deterministic synthetic market (prices, events, peers,
short-form news) for twelve invented issuers, SEC EDGAR current reports from 2026 Q2, and eCFR Title 17. It is
synthetic market data for a software demonstration and is not investment advice.

## What is in it

| Part | Origin | Contents |
|---|---|---|
| `market_analysis_structured` | generated, synthetic | 8 DuckDB tables plus the Parquet-only `market_news` stream, and 5 prediction views |
| `market_news` | downloaded, real | SEC EDGAR 8-K and 6-K filings from 2026 Q2: 1,000 pinned filings, 1,696 documents (primary documents and EX-99 exhibits) |
| `market_regulations` | downloaded, real | eCFR Title 17 as of 2026-08-17: 3,525 sections |
| `market_briefs` | committed, synthetic | 8 fictional briefs, one per synthetic event, joined to `news_articles` on `document_id` |

Profiles (`DATA_PACK_PROFILE`):

| Profile | Issuers | Sessions | `daily_prices` | `market_news` | Declared peers |
|---|---|---|---|---|---|
| `interactive` | 12 | 417 (from 2025-01-02) | 5,004 | 960 (every 5th session) | 14 curated pairs |
| `qualification` (default) | 2,000 | 679 (from 2024-01-02) | 1,358,000 | 84,000 (every 16th session) | 8,000 (4 per issuer) |

Every profile simulates prices from 2024-01-02 and keeps only its window, so the twelve story issuers have the same
prices in both. `assets.is_reviewed` marks them; the other 1,988 qualification issuers are cycled from them with
their own random draws, never copies of their rows.

## What is planted

- **Events**: eight news events from 2026-08-18 to 2026-08-28 move their issuer's price on publication day
  (`generation-spec.v1.json`, `events[].price_impact`; five positive, three negative).
- **Corporate actions**: a 2-for-1 Galena split on 2025-07-15 (raw prices halve; adjusted prices do not), and cash
  dividends for Aether (2026-05-15) and Meridian (2026-03-20).
- **Prediction**: the anchor is 2026-08-24 21:00 UTC with a five-session horizon. The `prediction` views expose only
  what was observable at the anchor, for the twelve story issuers.
- **Short-form news** (`market_news`): one descriptive item per issuer every N sessions, published after the close.
  Its sentiment label comes from the trailing five-session return (above +1.5% positive, below -1.5% negative).

## Files

| File | Purpose |
|---|---|
| `pack.yaml` | the manifest (see `data/README.md`) |
| `schema.sql`, `views/prediction.sql` | the DuckDB schema and the leakage-safe prediction views |
| `ontology.yaml` | table and column descriptions for Auto Ontology |
| `questions.yaml` | the demo questions; `featured` ones are the landing page and replay set |
| `generator/` | the synthetic generator, its specification and its news themes |
| `corpus/*.manifest.json` | the pinned eCFR snapshot and EDGAR filings (URL and SHA-256 of every file) |
| `documents/` | the fictional briefs and their manifest |
| `eval/` | SQL oracles and retrieval recall queries; never read at runtime |
| `recordings/` | the replay bundle, written by `scripts/demo.sh record` |

## Licenses

- Synthetic data and briefs: Apache-2.0.
- eCFR: United States government public information. The eCFR is authoritative but is not the official legal
  edition of the CFR.
- SEC EDGAR: SEC website reuse terms; redistribution unknown. Filings are fetched at prepare time and never
  committed; issuer-authored content may carry separate rights.

## Known issues

These are carried over unchanged from the original demo data.

- Six of the twelve fictional tickers collide with real listings.
- The synthetic prices and the real Q2 filings share no identifiers and no time window; the hybrid questions ask
  the agent to keep them apart.
- The short-form news sentiment is computed from past returns, so it is descriptive, not a signal.
- The short-form news exists only as Parquet (`load_into_database: false`), so Auto Ontology cannot see it.
- The PQL templates count calendar days (`0, 5, days`) while their descriptions say sessions.
- Return correlations (the tools' relationship graph) differ in the last bits between multi-threaded DuckDB runs;
  they are reproducible only with `SET threads = 1`.
- SEC regenerated the 2026 Q2 master index on 2026-09-26, after this snapshot was taken on 2026-09-22. The same
  1,000 filings are still selected, with the same metadata, so each filing is pinned with its index fields and the
  index itself is no longer downloaded.
