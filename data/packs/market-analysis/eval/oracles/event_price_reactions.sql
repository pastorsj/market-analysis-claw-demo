WITH sequenced AS (
  SELECT p.*,
    LAG(adjusted_close) OVER (PARTITION BY asset_id ORDER BY trading_date) AS prior_adjusted_close,
    LEAD(adjusted_close, 2) OVER (PARTITION BY asset_id ORDER BY trading_date) AS close_two_sessions_later
  FROM main.daily_prices p
)
SELECT n.article_id, n.primary_asset_id AS asset_id, n.published_at, n.sentiment_label,
  p.trading_date AS reaction_session,
  p.adjusted_close / p.prior_adjusted_close - 1.0 AS publication_session_return,
  p.close_two_sessions_later / p.adjusted_close - 1.0 AS following_two_session_return
FROM main.news_articles n
JOIN sequenced p ON p.asset_id = n.primary_asset_id
  AND p.trading_date = CAST(n.published_at AS DATE)
ORDER BY n.published_at, n.article_id;
