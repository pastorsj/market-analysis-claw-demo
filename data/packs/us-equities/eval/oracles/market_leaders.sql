-- market-leaders: the 1,000 most liquid stocks from 2025-01-02 to 2026-03-12, as market_scan measures them: the return
-- from the close before the window to its last close, and the standard deviation of the daily returns in it, with
-- the window's total volume.
WITH closes AS (
  SELECT p.asset_id, a.company_name, p.trading_date, p.adjusted_close, p.total_return_1d, p.volume,
    coalesce(lag(p.adjusted_close) OVER (PARTITION BY p.asset_id ORDER BY p.trading_date), p.adjusted_close)
      AS return_base
  FROM main.daily_prices p JOIN main.assets a USING (asset_id)
  WHERE a.liquidity_rank <= 1000
)
SELECT asset_id, company_name,
  arg_max(adjusted_close, trading_date) / arg_min(return_base, trading_date) - 1 AS total_return,
  stddev_samp(total_return_1d) AS daily_volatility,
  sum(volume) AS total_volume
FROM closes WHERE trading_date BETWEEN DATE '2025-01-02' AND DATE '2026-03-12'
GROUP BY asset_id, company_name
ORDER BY total_return DESC, asset_id;
