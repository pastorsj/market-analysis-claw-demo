# us-equities pack

Real US equities: daily prices for about 1,600 US-listed stocks, rolled up from real split-adjusted one-minute
bars, with SEC company names, CIKs and SIC codes; `intraday_scan` reads the minute bars themselves. The companies'
own SEC EDGAR 8-K filings, eCFR Title 17 and, opt-in, GDELT world headlines sit beside them as separate document
sources, searched by retrieval. It is real market data for a software demonstration and is not investment advice.

The minute bars are an **external dataset**: they are never committed. This directory holds only the pack
definition and the dataset's pinned fingerprint. Fetch the data first ([data platform](../../../docs/data-platform.md)):

```bash
# in .env: DATA_PACK=us-equities, and where the bars come from, e.g. a local copy or a bucket
DATA_SOURCE_MINUTE_BARS=/mnt/datasets/minute-bars
./scripts/demo.sh data fetch      # into $DATA_SOURCE_DIR/minute-bars, verified file by file
./scripts/demo.sh up              # builds the pack; on a running stack, also switches everything to it
```

## What is in it

| Part | Origin | Contents |
|---|---|---|
| `market_data` | external dataset `minute-bars`, plus SEC company data | 5 DuckDB tables and 3 prediction views; the raw minute bars, read in place |
| `sec_filings` | downloaded, real | 1,074 SEC EDGAR 8-Ks filed by the pack's companies from 2025-01-02 to 2026-03-12 (1,887 documents) |
| `market_regulations` | downloaded, real | eCFR Title 17 as of 2026-08-17 (3,525 sections) |
| `world_news` (opt-in) | external dataset `minute-bars`, read in place | 8,192 GDELT headlines, 2025-01-01 to 2026-02-02 |

Built from the pinned minute-bar dataset (fingerprint `d8b40510…`, 1.8 GB, 117 million bars for 2,200 symbols
from 2025-01-02 to 2026-03-12):

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
turned into it: they stay a document source, and each passage carries its filer's `ticker` as citation metadata,
so the agent can connect a filing to a stock across the two sources.

**The filings** are pinned in `corpus/sec-edgar-issuers.manifest.json`, which `corpus/select_filings.py` wrote
from each issuer's EDGAR submissions (they list the items each 8-K reports): every 8-K in the price window that
reports Item 1.05, a material cybersecurity incident, by any company in the pack (6 filings, by Conduent,
Coinbase, Data I/O, BayFirst and Coupang), plus the latest 12 8-Ks of each of the 100 most liquid stocks. The
first `prepare --corpus` downloads them from EDGAR (1.4 GB with `SEC_USER_AGENT`); later builds reuse the cache.
Rerun the script only to change the selection; its manifest is reviewed and committed like code.

**GDELT headlines** (`world_news`) are world news, linked to no stock, and many are topic summaries rather than
article titles. They are read in place from the dataset and built only when `DATA_CORPORA` names them, e.g.
`DATA_CORPORA=sec_filings,market_regulations,world_news`.

The prediction population is the 50 most liquid stocks at the anchor (2026-03-05 21:00 UTC), ranked on sessions up
to the anchor only; the build writes their ids into `pack.json`.

## Questions

`questions.yaml` holds ten questions; six are featured: market leaders among the 50 most liquid stocks, the
widest intraday swings from the minute bars (`intraday_scan`), unusual sessions among the 50 most liquid, the
peer network, the Form 8-K Item 1.05 rule with the filings that report an incident, and February's biggest movers
beside their own 8-Ks. `eval/oracles/` computes the analytics answers from a build and `eval/retrieval.yaml`
names the documents a retrieval answer should cite; CI runs the oracles on the fixture's schema only, since the
data is never in CI.

## Known issues

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
- Two corporate actions show in the prices as the dataset has them. ASST's reverse-split adjustment misses
  2026-02-05, its last session before the split, which stays unadjusted (a close of 0.50 between 11.97 and
  11.87): -95.8% and then +2,274%, and ASST sessions then fill an anomaly scan of `liquid_500` in 2026. AZN
  doubles on 2026-02-02, when its listing moved from American depositary shares (half a share each) to ordinary
  shares. The featured anomaly question scans `top_50`, which holds neither.
- Prices are split-adjusted, not dividend-adjusted: `adjusted_close` equals `close`.

## Files

| File | Purpose |
|---|---|
| `pack.yaml` | the manifest: the external dataset's pin, the `market` import settings, sources and analytics |
| `schema.sql`, `views/prediction.sql` | the DuckDB schema and the leakage-safe prediction views |
| `ontology.yaml` | table and column descriptions for Auto Ontology |
| `questions.yaml` | the demo questions; `featured` ones are the landing page and replay set |
| `corpus/*.manifest.json` | the pinned eCFR snapshot and EDGAR filings (URL and SHA-256 of every file) |
| `corpus/select_filings.py` | selects the filings from the issuers' EDGAR submissions and writes their manifest |
| `eval/` | SQL oracles for the analytics answers and the documents retrieval answers cite; never read at runtime |
| `recordings/` | the replay bundle of the featured questions (`demo.sh record`, [recordings](../../../docs/data-packs.md#recordings)); its figures and sample rows come from the external dataset, never the minute bars |
