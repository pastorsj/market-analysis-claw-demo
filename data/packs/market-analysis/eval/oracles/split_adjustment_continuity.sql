WITH around_split AS (
  SELECT p.asset_id, p.trading_date, p.raw_close, p.adjusted_close,
    LAG(p.raw_close) OVER (PARTITION BY p.asset_id ORDER BY p.trading_date) AS prior_raw_close,
    LAG(p.adjusted_close) OVER (PARTITION BY p.asset_id ORDER BY p.trading_date) AS prior_adjusted_close
  FROM main.daily_prices p
)
SELECT a.asset_id, a.effective_date, p.trading_date,
  p.raw_close / p.prior_raw_close - 1.0 AS raw_close_change,
  p.adjusted_close / p.prior_adjusted_close - 1.0 AS adjusted_close_change
FROM main.corporate_actions a
JOIN around_split p ON p.asset_id = a.asset_id AND p.trading_date = a.effective_date
WHERE a.action_type = 'stock_split'
ORDER BY a.asset_id;
