-- large-universe-scan: the 500 most liquid stocks' returns from 2026-01-02 to 2026-03-12 and how far their mean
-- daily volume in the window sits from the whole universe's (a z-score).
WITH window_prices AS (
  SELECT p.asset_id, p.trading_date, p.adjusted_close, p.volume
  FROM main.daily_prices p JOIN main.assets a USING (asset_id)
  WHERE a.liquidity_rank <= 500 AND p.trading_date BETWEEN DATE '2026-01-02' AND DATE '2026-03-12'
),
per_asset AS (
  SELECT asset_id,
    arg_max(adjusted_close, trading_date) / arg_min(adjusted_close, trading_date) - 1 AS total_return,
    avg(volume) AS mean_volume
  FROM window_prices GROUP BY asset_id
)
SELECT asset_id, total_return,
  (mean_volume - avg(mean_volume) OVER ()) / stddev_samp(mean_volume) OVER () AS volume_zscore
FROM per_asset
ORDER BY total_return DESC, asset_id;
