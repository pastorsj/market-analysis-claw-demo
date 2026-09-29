---
name: analyzing-market-data
description: Ranks assets and scans prices, anomalies, sentiment, news
license: Apache-2.0
compatibility: Requires the market_analytics MCP server and its six market tools
metadata:
  author: NVIDIA
  version: "1.0"
  hermes:
    tags:
      - market
      - prices
      - anomalies
      - sentiment
      - rapids
    related_skills:
      - querying-auto-ontology
      - predicting-with-kumo
---

# Analyzing market data

The market tools run fixed, GPU-accelerated calculations over the market data
selected for this turn. Each tool does one job. This skill helps you pick the
right one and avoid common mistakes.

## When to Use

- The selected sources include the `market_analytics` capability, and
- the question ranks assets, looks for unusual sessions, summarizes prices or
  news sentiment over a window, relates news sentiment to later returns, or
  asks which assets are central in the return-correlation graph.

For anything else, see "Use another skill" below.

## Choose the tool

| Question shape | Tool |
| --- | --- |
| Leaders or laggards by return, volume, volatility, or peer-relative return over a window | `market_scan` |
| Sessions that behave unusually compared with an earlier baseline period | `market_anomaly_scan` |
| Return, price range, and volume for named assets over a window | `price_context` |
| Counts of positive, neutral, and negative news labels by day, week, or month | `sentiment_timeline` |
| How news sentiment lined up with returns over the following sessions | `analyze_news_price_relationship` |
| Most central assets and strongest links in the fixed return-correlation graph | `analyze_market_relationships` |

In Hermes each tool's ID is `mcp__market_analytics__<tool>`, for example
`mcp__market_analytics__market_scan`.

## Use another skill

| Question shape | Skill |
| --- | --- |
| Sector or region rollups, drawdowns, dividends or splits, event windows, correlations for a chosen set of assets, reference attributes, or any exact rows | `querying-auto-ontology` |
| The likelihood of a future move or event | `predicting-with-kumo` |
| What a filing, disclosure, or rule says | `searching-documents` |

## Procedure

1. Take `universe_id` values, metric names, and limits only from the tool's own
   schema and description. Never guess a universe or use a source ID in its
   place.
2. Use timezone-aware RFC 3339 timestamps. For whole calendar days, start at
   `T00:00:00Z` on the first day and end at `T23:59:59Z` on the last day.
3. When the question needs both ends of a ranking, make two `market_scan` calls
   with the same universe, window, and metrics: one with `direction=highest`
   and one with `direction=lowest`. Do not fetch the whole universe to find the
   bottom.
4. For `market_anomaly_scan`, end the training window before the scoring window
   starts.
5. Pass tickers or asset IDs exactly as the user or an earlier result gave them.
   If a tool rejects an unknown or ambiguous asset, ask the user instead of
   guessing.

## Pitfalls

- Anomaly scores measure how unusual a session was. They are not probabilities,
  forecasts, or evidence of wrongdoing.
- News-versus-price statistics and graph links are correlations, not causes.
- The relationship graph is fixed for the whole dataset and cannot be limited to
  a named group of assets. For correlations within a chosen group, use
  `querying-auto-ontology`.
- Do not call a tool only to demonstrate speed.
- Do not give investment advice.

## Example

Question: "Which assets had the strongest and weakest returns last month?"

```
market_scan(universe_id="<value from the tool schema>", start="2026-08-01T00:00:00Z",
            end="2026-08-31T23:59:59Z", metrics=["return", "volatility"],
            direction="highest", limit=5)
market_scan(universe_id="<same value>", start="2026-08-01T00:00:00Z",
            end="2026-08-31T23:59:59Z", metrics=["return", "volatility"],
            direction="lowest", limit=5)
```

Cite each ranking with the `evidence_id` of the call that produced it.
