// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useLayoutStore } from '@/features/layout/store'
import { render, screen } from '@/test-utils'
import { useExecutionStore } from '../store'
import { fixtureEvents } from '../test-utils/fixtures'
import { ActivityPanel } from './ActivityPanel'

const JOB = fixtureEvents[0].jobId

describe('ActivityPanel', () => {
  beforeEach(() => useExecutionStore.setState({ runs: {}, dropped: 0 }))

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

  it('invites a question when there is no job', () => {
    render(<ActivityPanel jobId={null} />)
    expect(screen.getByText(/Ask a question/)).toBeVisible()
  })
})
