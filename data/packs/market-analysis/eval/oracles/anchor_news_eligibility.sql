SELECT article_id, primary_asset_id, published_at, ingested_at, event_type, sentiment_label
FROM main.news_articles
WHERE published_at <= TIMESTAMPTZ '2026-08-24T21:00:00+00:00'
  AND ingested_at <= TIMESTAMPTZ '2026-08-24T21:00:00+00:00'
ORDER BY published_at, article_id;
