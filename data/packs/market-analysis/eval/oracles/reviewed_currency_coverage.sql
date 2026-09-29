SELECT
  BOOL_OR(a.currency <> 'USD') AS any_observation_non_usd,
  CASE
    WHEN COUNT(DISTINCT a.currency) = 1 THEN MIN(a.currency)
    ELSE NULL
  END AS denomination_currency
FROM main.daily_prices AS p
JOIN main.assets AS a ON a.asset_id = p.asset_id
WHERE a.is_reviewed;
