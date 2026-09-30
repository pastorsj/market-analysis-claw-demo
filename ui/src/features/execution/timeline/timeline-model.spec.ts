// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { projectRun } from '../projection'
import { fixtureEvents } from '../test-utils/fixtures'
import { buildTimeline } from './timeline-model'

describe('buildTimeline', () => {
  it('lays out the golden run from its start, in time order', () => {
    const timeline = buildTimeline(fixtureEvents, projectRun(fixtureEvents))
    expect(timeline.totalMs).toBe(54016) // run.created 05:00:09.160 → run.completed 05:01:03.175
    expect(timeline.rows.map((row) => [row.kind, row.label])).toEqual([
      ['run', 'Hermes run'],
      ['model', 'Model call'],
      ['tool', 'Market Anomaly Scan'],
      ['tool', 'Unstructured Retrieval'],
      ['model', 'Model call'],
    ])
    const scan = timeline.rows[2]
    expect(scan).toMatchObject({
      startMs: 12430,
      durationMs: 2310,
      badges: ['1 evidence'],
      invocationId: 'hermes-tool:call_QhOAsXb68luYCFIAF1hWJ7z2',
    })
    expect(timeline.rows[4]).toMatchObject({
      durationMs: null,
      detail: '41,870 in · 2,796 out',
      badges: [],
    })
  })

  it('lists unknown event kinds by their label but never heartbeats', () => {
    const extra = [
      {
        ...fixtureEvents[1],
        eventId: 'r',
        eventKind: 'reasoning.available',
        display: { ...fixtureEvents[1].display, label: 'Planning' },
      },
      { ...fixtureEvents[1], eventId: 'h', eventKind: 'run.heartbeat' },
    ]
    const events = [fixtureEvents[0], ...extra]
    const labels = buildTimeline(events, projectRun(events)).rows.map((row) => row.label)
    expect(labels).toEqual(['Hermes run', 'Planning'])
  })

  it('is empty before the first event', () => {
    expect(buildTimeline([], projectRun([]))).toEqual({ rows: [], totalMs: 0 })
  })
})
