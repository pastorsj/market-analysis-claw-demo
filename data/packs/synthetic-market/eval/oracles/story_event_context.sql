-- story-event-context: each planted story (one per story issuer, 2026-08-17 to 2026-08-28) with its issuer's
-- return on the publication session and over the two sessions after it.
WITH sequenced AS (
  SELECT p.asset_id, p.trading_date, p.adjusted_close, p.total_return_1d,
    lead(p.adjusted_close, 2) OVER (PARTITION BY p.asset_id ORDER BY p.trading_date) AS close_two_later
  FROM main.daily_prices p
)
SELECT n.news_id, n.primary_asset_id AS asset_id, n.published_at, n.event_type, n.sentiment_label, n.headline,
  s.total_return_1d AS publication_session_return,
  s.close_two_later / s.adjusted_close - 1 AS following_two_session_return
FROM main.company_news n
JOIN sequenced s ON s.asset_id = n.primary_asset_id AND s.trading_date = CAST(n.published_at AS DATE)
WHERE n.is_story
ORDER BY n.published_at, n.news_id;
