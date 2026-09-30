// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  report: {
    citations: [{ number: 1, evidenceId: receiptOf('analytics_result').receiptId }],
  },
}

const renderWorkspace = (
  mode: 'live' | 'replay',
  focus: { referenceId?: string } | null = null
) => {
  const onClose = vi.fn()
  const view = render(<ExecutionWorkspace jobId={JOB} focus={focus} onClose={onClose} />, {
    config: { mode },
  })
  return { ...view, onClose }
}

describe('ExecutionWorkspace', () => {
  beforeEach(() => useExecutionStore.setState({ runs: {}, dropped: 0 }))
  afterEach(() => vi.restoreAllMocks())

  it('replays a recorded run: header, replay bar, run summary, graph and an explorer', () => {
    useExecutionStore.getState().addRecord(turn)
    const { onClose } = renderWorkspace('replay')

    const workspace = screen.getByRole('region', { name: 'Execution workspace' })
    expect(within(workspace).getByRole('heading', { name: 'Execution Graph' })).toBeVisible()
    expect(within(workspace).getByText('Hermes Recorded')).toBeVisible()
    expect(within(workspace).getByText('Step 10 of 10')).toBeVisible()
    expect(within(workspace).getByText('Answer complete')).toBeVisible()
    const summary = screen.getByRole('region', { name: 'Hermes run summary' })
    expect(within(summary).getByText('Citation/reference IDs resolved')).toBeVisible()
    expect(
      within(summary).getByText('1 cited evidence item(s) · 1 available but uncited')
    ).toBeVisible()
    expect(within(summary).getByText('106,217 tokens')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Inspect Market Anomaly Scan' }))
    const explorer = screen.getByRole('region', { name: 'Market Anomaly Scan explorer' })
    expect(
      within(explorer).getByRole('img', { name: /Anomaly score by observation/ })
    ).toBeVisible()
    // The explorer covers the graph, and the header gives way to it
    expect(screen.queryByRole('heading', { name: 'Execution Graph' })).toBeNull()

    fireEvent.click(within(explorer).getByRole('button', { name: 'Close explorer' }))
    fireEvent.click(screen.getByRole('button', { name: /Back to Answer/ }))
    expect(onClose).toHaveBeenCalled()
  })

  it('steps through the run: a node opens only while its call is at the cursor', () => {
    useExecutionStore.getState().addRecord(turn)
    renderWorkspace('replay')
    const position = screen.getByRole('slider', { name: 'Replay position' })

    fireEvent.change(position, { target: { value: '1' } })
    expect(screen.getByText('Step 1 of 10')).toBeVisible()
    expect(screen.getByText('Hermes Agent started')).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Hermes run summary' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Inspect Market Anomaly Scan' })).toBeNull()

    fireEvent.change(position, { target: { value: '3' } })
    expect(screen.getByText('Market Anomaly Scan started')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Market Anomaly Scan' }))
    expect(screen.getByRole('region', { name: 'Market Anomaly Scan explorer' })).toBeVisible()

    // Moving on leaves the explorer's call behind
    fireEvent.click(screen.getByRole('button', { name: 'Next execution step' }))
    expect(
      screen.getByRole('dialog', { name: 'Market Anomaly Scan replay status' })
    ).toHaveTextContent('Market Anomaly Scan is between observed calls')
  })

  it('opens on the evidence a citation points at, and again for the next citation', () => {
    useExecutionStore.getState().addRecord(turn)
    const { rerender } = renderWorkspace('replay', {
      referenceId: receiptOf('retrieval_evidence').receiptId,
    })

    const explorer = screen.getByRole('region', { name: 'Unstructured Retrieval explorer' })
    expect(within(explorer).getByText('1. CB Financial Services, Inc. 8-K: 8-K')).toBeVisible()
    fireEvent.click(within(explorer).getByRole('button', { name: 'Close explorer' }))
    expect(screen.queryByRole('region', { name: 'Unstructured Retrieval explorer' })).toBeNull()

    rerender(
      <ExecutionWorkspace
        jobId={JOB}
        focus={{ referenceId: receiptOf('analytics_result').receiptId }}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByRole('region', { name: 'Market Anomaly Scan explorer' })).toBeVisible()
  })

  it('loads a live run from the job export', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(turn))
    renderWorkspace('live')

    expect(
      await screen.findByRole('button', { name: 'Inspect Unstructured Retrieval' })
    ).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/jobs/async/job/${JOB}/export`, {
      cache: 'no-store',
    })
  })

  it('says so when a run has no execution record', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
    renderWorkspace('live')
    expect(
      await screen.findByText('No execution record is available for this answer.')
    ).toBeVisible()
  })
})
