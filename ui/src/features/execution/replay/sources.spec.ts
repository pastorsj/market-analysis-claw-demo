// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useExecutionStore } from '../store'
import { readRecording } from '../test-utils/fixtures'
import { loadJobExport, parseIndex, parseSession, recordings } from './sources'

const index = readRecording('index.json')
const session = readRecording('sessions/unusual-moves.json')

/** Serves the committed e2e bundle the way /api/recordings does. */
const serveBundle = () =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = String(input).replace('/api/recordings/', '')
    return path.startsWith('/')
      ? new Response(null, { status: 404 })
      : Response.json(readRecording(path))
  })

describe('recordings bundle (v2)', () => {
  beforeEach(() => useExecutionStore.setState({ runs: {}, dropped: 0 }))
  afterEach(() => vi.restoreAllMocks())

  it('parses the committed e2e bundle', () => {
    expect(parseIndex(index).sessions.map((s) => s.id)).toEqual([
      'unusual-moves',
      'structured-evidence',
    ])
    expect(parseSession(session).turns[0].events).toHaveLength(10)
  })

  it('asks for a re-record when the bundle is not v2', () => {
    expect(() => parseIndex({ formatVersion: 2 })).toThrow(/re-record/)
    expect(() => parseSession({ schemaVersion: 1, turns: [] })).toThrow(/re-record/)
  })

  it('lists the sessions and loads one into the chat and the execution store', async () => {
    serveBundle()
    expect(await recordings.list()).toEqual([
      {
        id: 'unusual-moves',
        title: 'Unusual moves and filings',
        recordedAt: '2026-09-28T06:00:00Z',
        questions: [
          'Which reviewed assets moved unusually this summer, and what did the filings say?',
        ],
      },
      {
        id: 'structured-evidence',
        title: 'Dividends and news likelihood',
        recordedAt: '2026-09-28T06:00:00Z',
        questions: [
          'Which cash dividends were paid in 2026, and how did they change total return?',
          'Which assets are most likely to have news in the next five days?',
        ],
      },
    ])

    const loaded = await recordings.load('structured-evidence')
    expect(loaded.turns.map((turn) => turn.jobId)).toEqual([
      '0dcd9841-b68a-456b-9dc5-87403c34efcb',
      '18d6824d-df8e-4d57-89eb-22a055226124',
    ])
    expect(loaded.turns[0]).toMatchObject({
      sourceIds: ['market_analysis_structured'],
      answer: expect.stringContaining('**References:**'),
    })
    const runs = useExecutionStore.getState().runs
    expect(runs['0dcd9841-b68a-456b-9dc5-87403c34efcb'].events).toHaveLength(5)
    expect(Object.keys(runs['18d6824d-df8e-4d57-89eb-22a055226124'].receipts)).toHaveLength(1)
    expect(useExecutionStore.getState().dropped).toBe(0)
  })

  it('loads a live job from its export', async () => {
    const turn = (session as { turns: unknown[] }).turns[0]
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(turn))
    await loadJobExport('2e1e9c6d-8c4a-4d2f-9716-1cb1e6659c78')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/jobs/async/job/2e1e9c6d-8c4a-4d2f-9716-1cb1e6659c78/export',
      { cache: 'no-store' }
    )
    const run = useExecutionStore.getState().runs['2e1e9c6d-8c4a-4d2f-9716-1cb1e6659c78']
    expect(Object.keys(run.receipts)).toHaveLength(2)
  })

  it('fails when the export is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
    await expect(loadJobExport('gone')).rejects.toThrow(/404/)
  })
})
