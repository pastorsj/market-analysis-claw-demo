-- laggards-follow-up (conversation): the 1,000 most liquid stocks' returns from 2025-01-02 to 2025-12-31 (turn 1) and from
-- 2025-01-02 to 2026-03-12 (turn 2), each from the close before its window to its last close.
WITH closes AS (
  SELECT p.asset_id, a.company_name, p.trading_date, p.adjusted_close,
    coalesce(lag(p.adjusted_close) OVER (PARTITION BY p.asset_id ORDER BY p.trading_date), p.adjusted_close)
      AS return_base
  FROM main.daily_prices p JOIN main.assets a USING (asset_id)
  WHERE a.liquidity_rank <= 1000
)
SELECT asset_id, company_name,
  arg_max(adjusted_close, trading_date) FILTER (WHERE trading_date BETWEEN DATE '2025-01-02' AND DATE '2025-12-31')
    / arg_min(return_base, trading_date) FILTER (WHERE trading_date BETWEEN DATE '2025-01-02' AND DATE '2025-12-31')
    - 1 AS year_2025_return,
  arg_max(adjusted_close, trading_date) FILTER (WHERE trading_date BETWEEN DATE '2025-01-02' AND DATE '2026-03-12')
    / arg_min(return_base, trading_date) FILTER (WHERE trading_date BETWEEN DATE '2025-01-02' AND DATE '2026-03-12')
    - 1 AS since_2025_return
FROM closes
GROUP BY asset_id, company_name
HAVING year_2025_return IS NOT NULL
ORDER BY year_2025_return, asset_id;
