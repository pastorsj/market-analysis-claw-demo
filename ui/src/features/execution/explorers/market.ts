// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The market analytics tools. `payload` is the tool's own result for the
 * operation (snake_case, see tools/market-analytics/src/market_analytics/models.py);
 * each operation gets a chart for the upstream ResultChart and a table.
 */

import type { AnalyticsResult } from '@/generated/receipt'
import { formatDuration } from '../format'
import {
  chart,
  day,
  facts,
  notes,
  numberOf,
  objectTable,
  records,
  sections,
  toCell,
} from './sections'
import type { Cell, EvidenceSection } from './types'

type Payload = Record<string, unknown>
type Operation = AnalyticsResult['operationId']

const scan = (payload: Payload) => {
  const observations = records(payload.observations)
  return sections(
    facts('Scan', [
      ['Universe', payload.universe_id],
      ['Metric', payload.primary_metric],
      ['Comparison', payload.comparison],
      ['Direction', payload.direction],
      ['Assets ranked', payload.assets_ranked],
    ]),
    chart({
      type: 'hbar',
      title: 'Score by asset',
      x: { key: 'asset' },
      series: [{ key: 'score', label: 'Score' }],
      data: observations.map((row) => ({
        asset: toCell(row.asset_id),
        score: numberOf(row.score),
      })),
    }),
    objectTable(
      'Ranked assets',
      observations.map(({ values, ...row }) => ({ ...row, ...(values as Payload) }))
    )
  )
}

const anomalies = (payload: Payload) => {
  const observations = records(payload.observations)
  const label = (row: Payload) => `${row.asset_id} ${day(row.timestamp)}`
  return sections(
    chart({
      type: 'hbar',
      title: 'Anomaly score by observation',
      subtitle: 'Higher is more unusual against the training window',
      x: { key: 'observation' },
      series: [{ key: 'score', label: 'Anomaly score' }],
      data: observations.map((row) => ({
        observation: label(row),
        score: numberOf(row.anomaly_score),
      })),
      kpis: [
        { label: 'Flagged', value: String(payload.flagged_observations ?? '–') },
        { label: 'Scored', value: String(payload.scoring_observations ?? '–') },
        { label: 'Training', value: String(payload.training_observations ?? '–') },
      ],
    }),
    objectTable(
      'Observed deviations (robust z-scores)',
      observations.map(({ observed_deviations, ...row }) => ({
        rank: row.rank,
        asset_id: row.asset_id,
        date: day(row.timestamp),
        anomaly_score: row.anomaly_score,
        cohort_percentile: row.cohort_percentile,
        ...(observed_deviations as Payload),
      }))
    )
  )
}

/** One line per asset: adjusted close by date. */
const priceContext = (payload: Payload) => {
  const series = records(payload.series)
  const assets = [...new Set(series.map((point) => String(point.asset_id)))]
  const byDate = new Map<string, Record<string, Cell>>()
  for (const point of series) {
    const date = day(point.timestamp)
    const row = byDate.get(date) ?? { date }
    row[String(point.asset_id)] = numberOf(point.adjusted_close)
    byDate.set(date, row)
  }
  const rows = [...byDate.values()]
  const step = Math.ceil(rows.length / 60)
  return sections(
    chart({
      type: 'line',
      title: 'Adjusted close',
      subtitle: step > 1 ? `Every ${step} sessions` : undefined,
      x: { key: 'date' },
      y: { format: 'currency' },
      series: assets.map((asset) => ({ key: asset })),
      data: rows.filter((_, index) => index % step === 0),
    }),
    objectTable('Summary', records(payload.summaries))
  )
}

const sentiment = (payload: Payload) => {
  const points = records(payload.points)
  return sections(
    chart({
      type: 'line',
      title: 'Mean news sentiment',
      subtitle: 'Negative −1, neutral 0, positive +1',
      x: { key: 'period' },
      series: [{ key: 'sentiment', label: 'Mean sentiment' }],
      data: points.map((row) => ({
        period: day(row.period_start),
        sentiment: numberOf(row.mean_sentiment),
      })),
    }),
    objectTable(
      'Periods',
      points.map((row) => ({ ...row, period_start: day(row.period_start) }))
    )
  )
}

const newsPrice = (payload: Payload) =>
  sections(
    facts('Alignment', [
      ['Horizon (sessions)', payload.return_horizon_sessions],
      ['Aligned events', payload.aligned_event_count],
      ['Eligible events', payload.eligible_event_count],
      ['Coverage', payload.coverage_ratio],
      ['Sentiment–return correlation', payload.sentiment_return_correlation],
    ]),
    chart({
      type: 'delta',
      title: 'Mean forward return by sentiment',
      x: { key: 'sentiment' },
      y: { format: 'percent' },
      series: [{ key: 'return', label: 'Mean forward return' }],
      data: records(payload.summaries).map((row) => ({
        sentiment: toCell(row.sentiment_label),
        return: numberOf(row.mean_forward_return),
      })),
    }),
    objectTable('Aligned events', records(payload.events))
  )

const relationships = (payload: Payload) =>
  sections(
    facts('Graph', [
      ['Window', `${payload.window_start} to ${payload.window_end}`],
      ['Assets', payload.node_count],
      ['Relationships', payload.edge_count],
    ]),
    chart({
      type: 'hbar',
      title: 'Centrality (PageRank)',
      x: { key: 'asset' },
      series: [{ key: 'centrality', label: 'Centrality' }],
      data: records(payload.central_assets).map((row) => ({
        asset: toCell(row.asset_id),
        centrality: numberOf(row.centrality),
      })),
    }),
    objectTable('Strongest correlations', records(payload.strongest_edges))
  )

/** Ranked asset sessions from the minute bars, labelled by asset and trading date. */
const intraday = (payload: Payload) => {
  const observations = records(payload.observations)
  return sections(
    facts('Scan', [
      ['Ranked by', payload.rank_by],
      ['Direction', payload.direction],
      ['Assets scanned', payload.assets_scanned],
      ['Sessions scanned', payload.sessions_scanned],
      ['Files read', payload.files_read],
      ['Batches', payload.batches],
    ]),
    chart({
      type: 'hbar',
      title: `Sessions by ${String(payload.rank_by ?? 'metric').replaceAll('_', ' ')}`,
      x: { key: 'session' },
      series: [{ key: 'value', label: String(payload.rank_by ?? 'value') }],
      data: observations.map((row) => ({
        session: `${row.asset_id} ${day(row.session)}`,
        value: numberOf(row[String(payload.rank_by)]),
      })),
    }),
    objectTable('Sessions', observations)
  )
}

const BY_OPERATION: Record<Operation, (payload: Payload) => EvidenceSection[]> = {
  market_scan: scan,
  market_anomaly_scan: anomalies,
  price_context: priceContext,
  sentiment_timeline: sentiment,
  analyze_news_price_relationship: newsPrice,
  analyze_market_relationships: relationships,
  intraday_scan: intraday,
}

export const marketSections = (content: AnalyticsResult): EvidenceSection[] =>
  sections(
    ...(content.payload ? BY_OPERATION[content.operationId](content.payload) : []),
    facts('Parameters', Object.entries(content.publicParameters)),
    facts('Computation', [
      ['Result', content.status],
      ['Data source', content.sourceId],
      ['Database', content.databaseName],
      [
        'Engine',
        content.engine &&
          `${content.engine.device.toUpperCase()} · ${content.engine.library} ${content.engine.version}`,
      ],
      ['Rows scanned', content.rowsScanned],
      ['Compute time', formatDuration(content.timing.computeMs)],
      ['Total time', formatDuration(content.timing.totalMs)],
    ]),
    notes('Warnings', content.warnings),
    notes('Limitations', content.limitations)
  )
