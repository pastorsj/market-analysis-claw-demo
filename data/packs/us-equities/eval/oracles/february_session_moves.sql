-- moves-and-filings: the sessions of the 50 most liquid stocks in February 2026, by open-to-close return (the
-- regular-session close over the open, minus 1; the daily bars are the minute bars' rollup, so these are
-- intraday_scan's). The question takes the three largest gains and the three largest losses; the filings of their
-- companies come from retrieval, separately.
SELECT p.asset_id, a.company_name, a.cik, p.trading_date, p.close / p.open - 1 AS open_to_close_return
FROM main.daily_prices p JOIN main.assets a USING (asset_id)
WHERE a.liquidity_rank <= 50 AND p.trading_date BETWEEN DATE '2026-02-01' AND DATE '2026-02-28'
ORDER BY open_to_close_return DESC, p.asset_id, p.trading_date;
