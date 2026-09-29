// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@/test-utils'
import { ExecutionWorkspace } from './ExecutionWorkspace'
import { useExecutionStore } from './store'
import { fixtureEvents, receiptOf } from './test-utils/fixtures'

const JOB = fixtureEvents[0].jobId
const turn = {
  jobId: JOB,
  question: 'Which assets moved unusually?',
  events: fixtureEvents,
  receipts: [receiptOf('analytics_result'), receiptOf('retrieval_evidence')],
}

const renderWorkspace = (mode: 'live' | 'replay', focus: { referenceId?: string } | null = null) =>
  render(<ExecutionWorkspace jobId={JOB} focus={focus} onClose={vi.fn()} />, {
    config: { mode },
  })

describe('ExecutionWorkspace', () => {
  beforeEach(() => useExecutionStore.setState({ runs: {}, dropped: 0 }))
  afterEach(() => vi.restoreAllMocks())

  it('replays a recorded run: summary, graph, and a tool explorer with its chart', async () => {
    useExecutionStore.getState().addRecord(turn)
    renderWorkspace('replay')

    expect(
      screen.getByText(/completed · 2 tool calls · 2 model calls · 106,217 tokens/)
    ).toBeVisible()
    expect(screen.getByText(/Step 10 of 10 · Run completed/)).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'Data' })).toBeNull()

    fireEvent.click(await screen.findByRole('group', { name: 'Market Anomaly Scan, completed' }))
    const explorer = screen.getByRole('region', { name: 'Market Anomaly Scan explorer' })
    expect(
      within(explorer).getByRole('img', { name: /Anomaly score by observation/ })
    ).toBeVisible()
    expect(within(explorer).getByText('GPU · cuml.accel 26.6.0')).toBeVisible()
  })

  it('opens on the evidence a citation points at', async () => {
    useExecutionStore.getState().addRecord(turn)
    renderWorkspace('replay', { referenceId: receiptOf('retrieval_evidence').receiptId })

    const explorer = screen.getByRole('region', { name: 'Unstructured Retrieval explorer' })
    expect(within(explorer).getByText('1. CB Financial Services, Inc. 8-K: 8-K')).toBeVisible()
  })

  it('shows the served models and opens a call from the timeline', async () => {
    useExecutionStore.getState().addRecord(turn)
    renderWorkspace('replay')

    fireEvent.click(await screen.findByRole('group', { name: 'Switchyard router, completed' }))
    const calls = screen.getByRole('region', { name: 'Model calls' })
    expect(within(calls).getByText('gpt-6-sol')).toBeVisible()

    await userEvent.click(screen.getByRole('tab', { name: 'Timeline' }))
    await userEvent.click(screen.getByRole('button', { name: 'Unstructured Retrieval' }))
    expect(screen.getByRole('region', { name: 'Unstructured Retrieval explorer' })).toBeVisible()
  })

  it('loads a live run from the job export', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(turn))
    renderWorkspace('live')

    expect(
      await screen.findByRole('group', { name: 'Unstructured Retrieval, completed' })
    ).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/jobs/async/job/${JOB}/export`, {
      cache: 'no-store',
    })
    expect(screen.getByRole('tab', { name: 'Data' })).toBeVisible()
  })

  it('says so when a run has no execution record', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
    renderWorkspace('live')
    expect(
      await screen.findByText('No execution record is available for this answer.')
    ).toBeVisible()
  })
})
