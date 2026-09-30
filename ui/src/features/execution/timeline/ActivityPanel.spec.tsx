// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLayoutStore } from '@/features/layout/store'
import { render, screen } from '@/test-utils'
import { useExecutionStore } from '../store'
import { fixtureEvents } from '../test-utils/fixtures'
import { ActivityPanel } from './ActivityPanel'

const JOB = fixtureEvents[0].jobId

describe('ActivityPanel', () => {
  beforeEach(() => useExecutionStore.setState({ runs: {}, dropped: 0 }))
  afterEach(() => vi.restoreAllMocks())

  it('follows the job’s events and opens its execution graph', async () => {
    const { addEvent } = useExecutionStore.getState()
    for (const event of fixtureEvents.slice(0, 4)) addEvent(JOB, event)
    render(<ActivityPanel jobId={JOB} />)

    expect(screen.getByText('running · 2 tool calls · 1 model call · 9,532 tokens')).toBeVisible()
    expect(screen.getByRole('list', { name: 'Execution timeline' })).toHaveTextContent(
      'Market Anomaly Scan'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Execution graph' }))
    expect(useLayoutStore.getState().execution).toEqual({ jobId: JOB, focus: null })
  })

  it('loads the job of a reopened session from its export', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ jobId: JOB, question: 'Q', events: fixtureEvents, receipts: [] })
      )
    render(<ActivityPanel jobId={JOB} />)

    expect(await screen.findByText(/^completed · 2 tool calls/)).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/jobs/async/job/${JOB}/export`, {
      cache: 'no-store',
    })
  })

  it('invites a question when there is no job', () => {
    render(<ActivityPanel jobId={null} />)
    expect(screen.getByText(/Ask a question/)).toBeVisible()
  })
})
