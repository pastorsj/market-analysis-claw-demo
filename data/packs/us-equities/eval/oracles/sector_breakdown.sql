-- sector-sql: stocks per SIC division and the division's median return from 2026-01-02 to 2026-03-12.
WITH returns AS (
  SELECT asset_id,
    arg_max(adjusted_close, trading_date) / arg_min(adjusted_close, trading_date) - 1 AS total_return
  FROM main.daily_prices WHERE trading_date BETWEEN DATE '2026-01-02' AND DATE '2026-03-12'
  GROUP BY asset_id
)
SELECT a.sector, count(*) AS stocks, median(r.total_return) AS median_return
FROM main.assets a LEFT JOIN returns r USING (asset_id)
GROUP BY a.sector
ORDER BY stocks DESC, a.sector;
