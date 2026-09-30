# us-equities pack

Real US equities: daily prices for about 1,600 US-listed stocks, rolled up from real split-adjusted one-minute
bars, with SEC company names, CIKs and SIC codes. SEC EDGAR filings and eCFR Title 17 sit beside them as separate
document sources, searched by retrieval. It is real market data for a software demonstration and is not
investment advice.

The minute bars are an **external dataset**: they are never committed. This directory holds only the pack
definition and the dataset's pinned fingerprint. Fetch the data first ([data platform](../../../docs/data-platform.md)):

```bash
# in .env: DATA_PACK=us-equities, and where the bars come from, e.g. a local copy or a bucket
DATA_SOURCE_MINUTE_BARS=/mnt/datasets/bfdmini/benchmark-subset
./scripts/demo.sh data fetch      # into $DATA_SOURCE_DIR/minute-bars, verified file by file
./scripts/demo.sh data prepare
```

## What is in it

| Part | Origin | Contents |
|---|---|---|
| `market_data` | external dataset `minute-bars`, plus SEC company data | 5 DuckDB tables and 3 prediction views |
| `sec_filings` | downloaded, real | SEC EDGAR 8-K and 6-K filings from 2026 Q2: 1,000 pinned filings by any filer |
| `market_regulations` | downloaded, real | eCFR Title 17 as of 2026-08-17 |

Built from the BFD benchmark subset (`bfdmini`, fingerprint `d8b40510…`, 1.8 GB, 117 million bars for 2,200
symbols from 2025-01-02 to 2026-03-12):

| Table | Rows | Built from |
|---|---|---|
| `trading_sessions` | 298 | dates on which at least half the symbols trading at the time have a regular-session bar |
| `assets` | 1,601 | the symbols left after the exclusions, with SEC data and a liquidity rank |
| `ticker_history` | 1,601 | one row per asset |
| `daily_prices` | 452,837 | the daily rollup (09:30 through the 16:00 closing auction) on sessions |
| `asset_relationships` | 8,862 | up to 8 most liquid peers with the same four-digit SIC code |

Of the 2,200 symbols, the importer drops 110 warrants, 50 units, 27 rights and 182 preferred shares, depositary
shares and notes (other securities of an issuer whose stock is in the data), 221 symbols SEC does not list (ETFs,
funds, and issuers delisted or renamed since: BK is BNY now), and 9 with fewer than 20 sessions. `pack.json`
records the counts under `parts.structured.import`.

The pack has **no ticker-linked news**: `analytics.news_table` is null, so `sentiment_timeline` and
`analyze_news_price_relationship` report that they are unavailable. SEC filings are not news and are never
turned into it; the agent connects a filing to a stock by company name, across the two sources.

The prediction population is the 50 most liquid stocks at the anchor (2026-03-05 21:00 UTC), ranked on sessions up
to the anchor only; the build writes their ids into `pack.json`.

## Known issues

- The filings are a 2026 Q2 sample by any filer, after the price window. A manifest of 8-Ks by this pack's
  issuers over the price window is planned.
- `session_close_utc` is 21:00, the eastern-standard-time close, so bar timestamps are an hour late while daylight
  saving time is in effect. `trading_sessions.close_at` has the exact close.
- On early-close days (2025-11-28, 2025-12-24), after-hours bars up to 16:00 count as regular.
- Nasdaq share classes cannot be told from notes by their symbol (CENTA and CMSA look alike), so a class share
  that is not its issuer's primary ticker is dropped as preferred. GOOGL, the primary ticker, stays beside GOOG.
- The other way round, about 20 notes and preferreds stay: those whose ticker does not extend their issuer's stock
  ticker (AOMN beside AOMR, CCZ beside CMCSA, DTB beside DTE) or whose issuer has no stock (the CHSC and BPYP
  series), one that SEC lists first for its issuer (BIPH before BIP), and a warrant whose stock has a new ticker
  (ABPWW).
- SEC's ticker list is today's, so issuers delisted or renamed after the price window are dropped as not listed.
- The smallest stocks trade a few hundred dollars a day, and single trades give them extreme daily returns
  (CYCL: +26,167% on 2025-02-20). Whole-market scans need a liquidity floor, such as the `liquid_500` universe.
- Prices are split-adjusted, not dividend-adjusted: `adjusted_close` equals `close`.

## Files

| File | Purpose |
|---|---|
| `pack.yaml` | the manifest: the external dataset's pin, the `market` import settings, sources and analytics |
| `schema.sql`, `views/prediction.sql` | the DuckDB schema and the leakage-safe prediction views |
| `ontology.yaml` | table and column descriptions for Auto Ontology |
| `questions.yaml` | draft demo questions; `featured` ones are the landing page |
| `corpus/*.manifest.json` | the pinned eCFR snapshot and EDGAR filings |
