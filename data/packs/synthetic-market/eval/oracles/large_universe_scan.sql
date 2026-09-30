-- large-universe-scan: every issuer's return from its first close on or after 2024-01-02 to its last on or
-- before 2026-08-31; the question asks for the 20 strongest and the 20 weakest.
WITH window_prices AS (
  SELECT asset_id, arg_min(adjusted_close, trading_date) AS first_close, arg_max(adjusted_close, trading_date) AS last_close,
    stddev_samp(total_return_1d) AS daily_volatility
  FROM main.daily_prices WHERE trading_date BETWEEN DATE '2024-01-02' AND DATE '2026-08-31' GROUP BY 1
)
SELECT asset_id, last_close / first_close - 1 AS total_return, daily_volatility
FROM window_prices
ORDER BY total_return DESC, asset_id;
