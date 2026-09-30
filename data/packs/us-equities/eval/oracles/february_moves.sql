-- moves-and-filings: the 50 most liquid stocks' returns over February 2026 (first to last close in the month).
-- The question takes the three strongest and the three weakest; their filings come from retrieval, separately.
WITH february AS (
  SELECT p.asset_id, a.company_name, a.cik, p.trading_date, p.adjusted_close
  FROM main.daily_prices p JOIN main.assets a USING (asset_id)
  WHERE a.liquidity_rank <= 50 AND p.trading_date BETWEEN DATE '2026-02-01' AND DATE '2026-02-28'
)
SELECT asset_id, company_name, cik,
  arg_max(adjusted_close, trading_date) / arg_min(adjusted_close, trading_date) - 1 AS february_return
FROM february
GROUP BY asset_id, company_name, cik
ORDER BY february_return DESC, asset_id;
