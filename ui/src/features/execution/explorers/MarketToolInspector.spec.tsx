// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@/test-utils'
import type { AnalyticsResultReceipt } from '../contract'
import { receiptOf } from '../test-utils/fixtures'
import { MarketToolInspector } from './MarketToolInspector'

type Content = NonNullable<AnalyticsResultReceipt['content']>

const withContent = (content: Partial<Content>): AnalyticsResultReceipt => {
  const receipt = receiptOf('analytics_result')
  return { ...receipt, content: { ...receipt.content!, ...content } }
}

const renderReceipt = (receipt: AnalyticsResultReceipt | null, title = 'Market Tool') =>
  render(<MarketToolInspector toolTitle={title} receipt={receipt} />)

describe('MarketToolInspector', () => {
  it('shows a GPU call’s receipt: engine, input, timing, return and source', () => {
    renderReceipt(receiptOf('analytics_result'), 'Market Anomaly Scan')

    const card = screen.getByTestId('market-tool-receipt')
    expect(within(card).getByText('NVIDIA GPU tool receipt')).toBeVisible()
    expect(within(card).getByRole('heading', { name: 'Market Anomaly Scan' })).toBeVisible()
    expect(
      within(card).getByText(
        'reviewed_assets · Baseline 2026-01-02 → 2026-06-30 · Score 2026-07-01 → 2026-08-31 · Top 5'
      )
    ).toBeVisible()
    expect(within(card).getByText('cuML 26.6.0')).toBeVisible()
    expect(within(card).getByText('cuml.accel')).toBeVisible()
    expect(within(card).getByText('GPU observed')).toBeVisible()
    expect(within(card).getByText('173 ms')).toBeVisible()
    expect(within(card).getByText('market_analysis')).toBeVisible()
    expect(screen.getByTestId('market-tool-inspector')).toHaveAttribute('data-accelerated', 'true')
  })

  it('ranks the flagged anomalies with their strongest deviation', () => {
    renderReceipt(receiptOf('analytics_result'))
    expect(screen.getByRole('heading', { name: '31 flagged observations' })).toBeVisible()
    const ranking = screen.getByLabelText('Anomaly score ranking')
    expect(within(ranking).getByText(/^asset-delta · 2026-/)).toBeVisible()
    expect(within(ranking).getAllByText(/100th percentile · Flagged/)[0]).toBeVisible()
  })

  it('shows a CPU call as a plain tool receipt', () => {
    renderReceipt(
      withContent({ engine: { device: 'cpu', library: 'scikit-learn', version: '1.7.2' } })
    )
    expect(screen.getByText('Tool execution receipt')).toBeVisible()
    expect(screen.getByText('scikit-learn 1.7.2')).toBeVisible()
    expect(screen.getByText('CPU reported')).toBeVisible()
  })

  it('ranks a market scan, in percent for returns and not for z-scores', () => {
    const payload = {
      universe_id: 'reviewed_assets',
      primary_metric: 'return',
      comparison: 'absolute',
      direction: 'highest',
      assets_ranked: 12,
      observations: [
        {
          rank: 1,
          asset_id: 'asset-aether',
          score: -0.0094,
          values: { return: -0.0094 },
          observation_count: 20,
          coverage_ratio: 1,
        },
      ],
    }
    const { unmount } = renderReceipt(withContent({ operationId: 'market_scan', payload }))
    expect(screen.getByText('−0.94%')).toBeVisible()
    expect(screen.getByText('12 assets')).toBeVisible()
    unmount()

    renderReceipt(
      withContent({ operationId: 'market_scan', payload: { ...payload, comparison: 'zscore' } })
    )
    expect(screen.getByText('−0.0094')).toBeVisible()
  })

  it('draws a price chart with its legend and per-asset returns', () => {
    renderReceipt(
      withContent({
        operationId: 'price_context',
        publicParameters: { asset_ids: ['a', 'b'], start: '2026-08-01T00:00:00Z' },
        payload: {
          frequency: 'daily',
          series_truncated: false,
          summaries: [{ asset_id: 'a', total_return: 0.05, start_price: 10, end_price: 10.5 }],
          series: [
            { asset_id: 'a', timestamp: '2026-08-01T00:00:00Z', adjusted_close: 10, volume: 1 },
            { asset_id: 'a', timestamp: '2026-08-02T00:00:00Z', adjusted_close: 10.5, volume: 1 },
          ],
        },
      })
    )
    expect(screen.getByTestId('market-price-series')).toBeVisible()
    expect(screen.getByLabelText('Price series legend')).toHaveTextContent('a')
    expect(screen.getByText('+5% return')).toBeVisible()
  })

  it('stacks the sentiment of each period', () => {
    renderReceipt(
      withContent({
        operationId: 'sentiment_timeline',
        payload: {
          frequency: 'weekly',
          articles_considered: 9,
          points_truncated: false,
          points: [
            {
              period_start: '2026-08-03T00:00:00Z',
              article_count: 9,
              positive_count: 5,
              neutral_count: 3,
              negative_count: 1,
              mean_sentiment: 0.4444,
            },
          ],
        },
      })
    )
    expect(screen.getByRole('heading', { name: '9 articles considered' })).toBeVisible()
    expect(screen.getByLabelText('9 observed articles')).toBeVisible()
    expect(screen.getByText('+0.4444')).toBeVisible()
  })

  it('lines up news with the returns that followed, without a causal claim', () => {
    renderReceipt(
      withContent({
        operationId: 'analyze_news_price_relationship',
        payload: {
          return_horizon_sessions: 5,
          eligible_event_count: 2,
          aligned_event_count: 2,
          coverage_ratio: 1,
          sentiment_return_correlation: 0.31,
          summaries: [],
          events_truncated: false,
          events: [
            {
              news_id: 'n1',
              asset_id: 'asset-ion',
              published_at: '2026-08-18T13:00:00Z',
              sentiment_label: 'negative',
              forward_return: -0.021,
            },
          ],
        },
      })
    )
    expect(screen.getByText('Descriptive correlation +0.31')).toBeVisible()
    expect(screen.getByText('−2.1%')).toBeVisible()
    expect(screen.getByText('Observed descriptive relationship; no causal claim.')).toBeVisible()
  })

  it('draws the strongest relationships around the most central assets', () => {
    renderReceipt(
      withContent({
        operationId: 'analyze_market_relationships',
        publicParameters: { top_k: 2 },
        payload: {
          window_start: '2026-06-01',
          window_end: '2026-08-31',
          node_count: 12,
          edge_count: 40,
          central_assets: [
            { rank: 1, asset_id: 'asset-a', centrality: 0.2 },
            { rank: 2, asset_id: 'asset-b', centrality: 0.1 },
          ],
          strongest_edges: [
            { source_asset_id: 'asset-a', target_asset_id: 'asset-b', correlation: -0.8 },
          ],
        },
      })
    )
    expect(screen.getByTestId('market-relationship-network')).toBeVisible()
    expect(screen.getByText('12 nodes · 40 edges in source graph')).toBeVisible()
    expect(screen.getByLabelText('Ranked relationship assets')).toHaveTextContent('asset-a')
    expect(screen.getByText('Return Correlation · Top 2')).toBeVisible()
  })

  it('shows why a call failed, and says when there is no receipt yet', () => {
    const { unmount } = renderReceipt(
      withContent({
        status: 'failed',
        payload: null,
        error: { code: 'invalid_request', message: 'No such universe.' },
      })
    )
    expect(screen.getByTestId('market-native-empty')).toHaveTextContent('No such universe.')
    unmount()

    renderReceipt(null)
    expect(screen.getByTestId('market-native-empty')).toHaveTextContent(
      'No display-safe market-tool receipt is available at this replay step.'
    )
  })
})
