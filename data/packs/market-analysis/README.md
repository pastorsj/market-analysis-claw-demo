# market-analysis (retired)

The first demo pack, a generated market of 12 fictional issuers, was replaced by
[`synthetic-market`](../synthetic-market/README.md) and [`us-equities`](../us-equities/README.md). Only its replay
bundle is left, in `recordings/`, until the new packs are recorded:

```bash
DATA_PACK=market-analysis ./scripts/demo.sh replay
```

Replay needs nothing but the bundle, so the pack itself is gone: `demo-data` no longer lists or builds it. In the
bundle, `market_news` is the SEC EDGAR filings source, a document source like `sec_filings` in the current packs.
