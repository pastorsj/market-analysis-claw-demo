WITH ranked AS (
  SELECT p.*, t.ticker, a.company_name,
    ROW_NUMBER() OVER (PARTITION BY p.asset_id ORDER BY p.trading_date DESC) AS recency
  FROM main.daily_prices p
  JOIN main.assets a ON a.asset_id = p.asset_id
  JOIN main.ticker_history t ON t.asset_id = p.asset_id
    AND p.trading_date >= t.effective_from
    AND (t.effective_to IS NULL OR p.trading_date < t.effective_to)
  WHERE p.trading_date <= DATE '2026-08-31'
    AND a.is_reviewed
), summarized AS (
  SELECT asset_id, ticker, company_name,
    MAX(adjusted_close) FILTER (WHERE recency = 1) AS ending_close,
    MAX(adjusted_close) FILTER (WHERE recency = 20) AS starting_close,
    STDDEV_SAMP(total_return_1d) FILTER (WHERE recency <= 20) AS daily_volatility
  FROM ranked WHERE recency <= 20 GROUP BY asset_id, ticker, company_name
)
SELECT asset_id, ticker, company_name,
  ending_close / starting_close - 1.0 AS adjusted_return,
  daily_volatility
FROM summarized
ORDER BY adjusted_return DESC, asset_id;
