WITH ranked AS (
  SELECT p.asset_id, a.sector, p.adjusted_close,
    ROW_NUMBER() OVER (PARTITION BY p.asset_id ORDER BY p.trading_date DESC) AS recency
  FROM main.daily_prices p JOIN main.assets a ON a.asset_id = p.asset_id
  WHERE p.trading_date <= DATE '2026-08-31'
    AND a.is_reviewed
), asset_returns AS (
  SELECT asset_id, sector,
    MAX(adjusted_close) FILTER (WHERE recency = 1)
      / MAX(adjusted_close) FILTER (WHERE recency = 20) - 1.0 AS adjusted_return
  FROM ranked WHERE recency <= 20 GROUP BY asset_id, sector
)
SELECT sector, COUNT(*) AS asset_count, AVG(adjusted_return) AS equal_weight_adjusted_return
FROM asset_returns GROUP BY sector
ORDER BY equal_weight_adjusted_return DESC, sector;
