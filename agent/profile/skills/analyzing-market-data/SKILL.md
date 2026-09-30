---
name: analyzing-market-data
description: Ranks assets; scans prices, anomalies, news, minute bars
license: Apache-2.0
compatibility: Requires the market_analytics MCP server and its seven market tools
metadata:
  author: NVIDIA
  version: "1.1"
  hermes:
    tags:
      - market
      - prices
      - anomalies
      - sentiment
      - intraday
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
  news sentiment over a window, relates news sentiment to later returns, asks
  which assets are central in the return-correlation graph, or asks how
  sessions traded minute by minute.

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
| Intraday range, minute-level volatility, open-to-close move, drawdown from the high, or volume timing of sessions | `intraday_scan` |

In Hermes each tool's ID is `mcp__market_analytics__<tool>`, for example
`mcp__market_analytics__market_scan`.

## Use another skill

| Question shape | Skill |
| --- | --- |
| Sector or region rollups, drawdowns, dividends or splits, event windows, correlations for a chosen set of assets, reference attributes, or any exact rows | `querying-auto-ontology` |
| The likelihood of a future move or event | `predicting-with-kumo` |
| What a filing, disclosure, or rule says | `searching-documents` |

## Procedure

1. Copy `universe_id` exactly from the values listed in the tool's schema,
   whose description says which assets each one holds. The values differ
   between data packs, so never build one from the question's wording (a
   question about "the 12 most liquid" does not make `top_50` valid). If no
   listed universe matches, use the closest one and say which you used. Take
   metric names and limits from the schema too, and never pass a source ID.
2. Use timezone-aware RFC 3339 timestamps. For whole calendar days, start at
   `T00:00:00Z` on the first day and end at `T23:59:59Z` on the last day.
3. Use the window the question states. For "the N trading sessions ending D",
   set `end` to D and `start` about 1.5 × N calendar days earlier, then check
   that `observation_count` is N in the result. If it is not, move `start` and
   scan once more. Say which dates the window covers.
4. When the question asks for leaders and laggards (strongest and weakest, best
   and worst), make two `market_scan` calls with the same universe, window, and
   metrics: one with `direction=highest` and one with `direction=lowest`. Use
   the number of results the question asks for, and `limit=3` when it gives
   none. Report both ends. Do not fetch the whole universe to find the bottom.
5. For `market_anomaly_scan`, end the training window before the scoring window
   starts.
6. Pass tickers or asset IDs exactly as the user or an earlier result gave them.
   If a tool rejects an unknown or ambiguous asset, ask the user instead of
   guessing.
7. For `intraday_scan`, name `asset_ids` or a `universe_id`, and keep the window
   to the sessions asked about: it reads the raw minute bars.
8. A tool whose description starts with "Unavailable in the active data pack"
   fails with `news_unavailable` or `minute_bars_unavailable`. Do not call it or
   retry it. Say that the pack has no ticker-linked news or no minute bars, and
   answer with the other tools. SEC filings are documents, not news: search them
   with `searching-documents`.

## Units

The tools return fractions, not percentages. Convert them when you write:

- `return`, peer-relative return, `open_to_close_return`, `intraday_range`,
  `max_drawdown` and volume shares: 0.2474 is 24.74%, and 1.0166 is +101.66%.
- `volatility` is the standard deviation of daily returns: 0.0286 is 2.86% a
  day.
- `comparison=zscore` scores and the anomaly scan's `observed_deviations` are
  robust z-scores: write "+4.2 robust z-score", never a percentage.
- Never write a return as a multiple ("×") and never put a % sign on an
  unconverted fraction.

## Pitfalls

- Anomaly scores measure how unusual a session was. They are not probabilities,
  forecasts, or evidence of wrongdoing.
- News-versus-price statistics and graph links are correlations, not causes.
- Intraday metrics cover the regular session only. The volume shares are of
  the session's volume, and the last 30 minutes include the closing auction.
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
            direction="highest", limit=3)
market_scan(universe_id="<same value>", start="2026-08-01T00:00:00Z",
            end="2026-08-31T23:59:59Z", metrics=["return", "volatility"],
            direction="lowest", limit=3)
```

Answer with the three leaders and the three laggards, their returns and
volatilities as percentages, and the window. Cite each row with the
`evidence_id` of the call that produced it.
