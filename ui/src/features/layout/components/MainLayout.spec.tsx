// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useChatStore } from '@/features/chat'
import type { ExecutionWorkspaceProps, RecordingsSource } from '@/shared/context'
import { useLayoutStore } from '../store'
import { MainLayout } from './MainLayout'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/research',
  useSearchParams: () => new URLSearchParams(),
}))

const initialChat = useChatStore.getState()
const initialLayout = useLayoutStore.getState()

const SOURCES = [
  { id: 'market_analysis_structured', name: 'Market data' },
  { id: 'market_news', name: 'Market news' },
]

const recordings: RecordingsSource = {
  list: async () => [{ id: 'rec-1', title: 'Market leaders', recordedAt: '2026-09-01T00:00:00Z' }],
  load: async () => ({
    id: 'rec-1',
    title: 'Market leaders',
    recordedAt: '2026-09-01T00:00:00Z',
    turns: [
      {
        question: 'Which assets led?',
        answer: 'Asset A led.',
        jobId: 'job-1',
        sourceIds: ['market_analysis_structured'],
      },
    ],
  }),
}

describe('MainLayout', () => {
  beforeEach(() => {
    useChatStore.setState(initialChat, true)
    useChatStore.getState().setCurrentUser('local')
    useLayoutStore.setState({ ...initialLayout, availableDataSources: SOURCES }, true)
  })

  test('live mode offers the composer and data sources', () => {
    render(<MainLayout />)

    expect(screen.getByRole('textbox', { name: 'Chat message input' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add data sources' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start new session/i })).toBeInTheDocument()
  })

  test('replay mode lists recordings and opens one read-only', async () => {
    render(<MainLayout />, { config: { mode: 'replay' }, feature: { recordings } })

    expect(screen.queryByRole('textbox', { name: 'Chat message input' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add data sources' })).not.toBeInTheDocument()

    await userEvent.click(await screen.findByText('Market leaders'))

    expect(await screen.findByText('Asset A led.')).toBeInTheDocument()
    expect(useChatStore.getState().currentConversation?.readOnly).toBe(true)
    // Recorded sessions are shown, never saved.
    expect(useChatStore.getState().conversations).toEqual([])
  })

  test('places a featured question and its data sources in a new session', async () => {
    render(
      <MainLayout initialQuestion={{ question: 'Which assets led?', sourceIds: ['market_news'] }} />
    )

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).toHaveValue(
        'Which assets led?'
      )
    )
    expect(useLayoutStore.getState().enabledDataSourceIds).toEqual(['market_news'])
  })

  test('shows the execution workspace for an opened run', async () => {
    const Workspace = ({ jobId, onClose }: ExecutionWorkspaceProps) => (
      <button onClick={onClose}>Workspace for {jobId}</button>
    )
    useLayoutStore.getState().openExecution('job-1')
    render(<MainLayout />, { feature: { Workspace } })

    await userEvent.click(screen.getByRole('button', { name: 'Workspace for job-1' }))

    expect(useLayoutStore.getState().execution).toBeNull()
    expect(screen.queryByText('Workspace for job-1')).not.toBeInTheDocument()
  })
})
