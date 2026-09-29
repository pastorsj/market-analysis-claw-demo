// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import type { AnalyticsResult } from '@/generated/receipt'
import { ChartSpecSchema } from '@/shared/components/ResultChart'
import { receiptOf } from '../test-utils/fixtures'
import { explorerSections, type EvidenceSection } from './index'
import { marketSections } from './market'
import { sqlSections } from './sql'

const find = <K extends EvidenceSection['kind']>(
  list: EvidenceSection[],
  kind: K,
  title?: string
) =>
  list.find((s) => s.kind === kind && (!title || s.title === title)) as
    | Extract<EvidenceSection, { kind: K }>
    | undefined

const factsOf = (list: EvidenceSection[], title: string) =>
  Object.fromEntries(find(list, 'facts', title)!.facts.map((fact) => [fact.label, fact.value]))

/** Every chart an explorer emits must be a spec the upstream ResultChart accepts. */
const expectValidCharts = (list: EvidenceSection[]) => {
  for (const section of list) {
    if (section.kind === 'chart') expect(ChartSpecSchema.safeParse(section.spec).success).toBe(true)
  }
}

describe('explorer sections', () => {
  it('retrieval: the search, its passages with EDGAR citations, and the stage timings', () => {
    const list = explorerSections(receiptOf('retrieval_evidence'))
    expect(factsOf(list, 'Search')).toMatchObject({
      Index: 'HNSW · COSINE',
      Reranker: 'nvidia/llama-nemotron-rerank-vl-1b-v2',
      Candidates: 'market_news 48',
    })
    const passages = find(list, 'passages')!.passages
    expect(passages).toHaveLength(3)
    expect(passages[0]).toMatchObject({
      title: '1. CB Financial Services, Inc. 8-K: 8-K',
      source: 'market_news · 2026-05-11',
      citation: expect.stringContaining('accession 0001605301-26-000021'),
    })
    expect(find(list, 'facts', 'Timing')).toBeDefined()
  })

  it('retrieval: links only http(s) URLs', () => {
    const receipt = receiptOf('retrieval_evidence')
    const [hit] = receipt.content!.hits
    const urls = ['https://www.sec.gov/a', 'javascript:alert(1)', null].map((url) => {
      const content = { ...receipt.content!, hits: [{ ...hit, url }] }
      return find(explorerSections({ ...receipt, content }), 'passages')!.passages[0].url
    })
    expect(urls).toEqual(['https://www.sec.gov/a', null, null])
  })

  it('market anomaly scan: a ranked chart with KPIs, deviations, engine and limitations', () => {
    const list = explorerSections(receiptOf('analytics_result'))
    const chart = find(list, 'chart')!
    expect(chart.spec.type).toBe('hbar')
    expect(chart.spec.data[0]).toEqual({
      observation: 'asset-delta 2026-08-24',
      score: 1.2816038131713867,
    })
    expect(chart.spec.kpis?.[0]).toEqual({ label: 'Flagged', value: '31' })
    expect(find(list, 'table')!.columns).toContain('realized_volatility_20d')
    expect(factsOf(list, 'Computation').Engine).toBe('GPU · cuml.accel 26.6.0')
    expect(find(list, 'notes', 'Limitations')!.notes).toHaveLength(2)
    expectValidCharts(list)
  })

  it('structured query: ontology grounding graph, lineage, SQL and rows', () => {
    const list = explorerSections(receiptOf('structured_query'))
    const graph = find(list, 'graph')!
    expect(graph.nodes.map((n) => n.id)).toContain('column:main.corporate_actions.cash_amount_usd')
    expect(graph.edges).toContainEqual({
      source: 'phrase:corporate-action cash amount',
      target: 'object:Cash Amount Usd',
    })
    expect(find(list, 'code')).toMatchObject({ language: 'sql' })
    expect(find(list, 'table', 'Rows (2)')!.note).toBeUndefined()
  })

  it('sql: notes rows the plugin cut', () => {
    const content = {
      ...receiptOf('structured_query').content!,
      truncated: true,
      sourceRowCount: 80,
    }
    expect(find(sqlSections(content), 'table')!.note).toBe('Showing 2 of 80 rows.')
  })

  it('prediction: PQL and per-asset probabilities as a percent chart', () => {
    const list = explorerSections(receiptOf('structured_prediction'))
    expect(find(list, 'code')).toMatchObject({
      language: 'pql',
      code: expect.stringMatching(/^PREDICT/),
    })
    const chart = find(list, 'chart')!
    expect(chart.spec.y?.format).toBe('percent')
    expect(chart.spec.data[0]).toEqual({ asset: 'asset-delta', probability: 0.8469578623771667 })
    expectValidCharts(list)
  })

  it('a failed prediction explains why and draws no chart', () => {
    const list = explorerSections(receiptOf('structured_prediction', 'failed'))
    expect(factsOf(list, 'Call')).toMatchObject({
      Status: 'failed',
      Error: 'evidence_unavailable: ConnectError: [Errno 111] Connection refused',
    })
    expect(factsOf(list, 'Prediction')['Not available']).toContain('Connection refused')
    expect(find(list, 'chart')).toBeUndefined()
  })
})

describe('market operations', () => {
  const result = (operationId: AnalyticsResult['operationId'], payload: Record<string, unknown>) =>
    marketSections({ ...receiptOf('analytics_result').content!, operationId, payload })

  it.each<[AnalyticsResult['operationId'], Record<string, unknown>, string]>([
    [
      'market_scan',
      { observations: [{ rank: 1, asset_id: 'a', score: 0.4, values: { total_return: 0.4 } }] },
      'hbar',
    ],
    [
      'price_context',
      {
        series: [
          { asset_id: 'a', timestamp: '2026-07-01T21:00:00Z', adjusted_close: 10 },
          { asset_id: 'b', timestamp: '2026-07-01T21:00:00Z', adjusted_close: 20 },
        ],
        summaries: [{ asset_id: 'a', total_return: 0.1 }],
      },
      'line',
    ],
    [
      'sentiment_timeline',
      { points: [{ period_start: '2026-07-01T00:00:00Z', mean_sentiment: 0.2 }] },
      'line',
    ],
    [
      'analyze_news_price_relationship',
      { summaries: [{ sentiment_label: 'positive', mean_forward_return: 0.01 }], events: [] },
      'delta',
    ],
    [
      'analyze_market_relationships',
      { central_assets: [{ rank: 1, asset_id: 'a', centrality: 0.3 }], strongest_edges: [] },
      'hbar',
    ],
  ])('%s draws a %s chart the ResultChart accepts', (operation, payload, type) => {
    const list = result(operation, payload)
    expect(find(list, 'chart')!.spec.type).toBe(type)
    expectValidCharts(list)
  })

  it('price context draws one line per asset by date', () => {
    const list = result('price_context', {
      series: [
        { asset_id: 'a', timestamp: '2026-07-01T21:00:00Z', adjusted_close: 10 },
        { asset_id: 'b', timestamp: '2026-07-01T21:00:00Z', adjusted_close: 20 },
      ],
    })
    const chart = find(list, 'chart')!
    expect(chart.spec.series.map((s) => s.key)).toEqual(['a', 'b'])
    expect(chart.spec.data).toEqual([{ date: '2026-07-01', a: 10, b: 20 }])
  })

  it('an empty result keeps its parameters and computation facts only', () => {
    const list = result('market_scan', { observations: [] })
    expect(list.map((s) => s.title)).toEqual(['Parameters', 'Computation', 'Limitations'])
  })
})
