// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fetchDataSources, getJobStatus, submitJob } from '@/adapters/api'
import { useHermesChat } from '@/features/chat/hooks/use-hermes-chat'
import { useChatStore } from '@/features/chat/store'
import type { Conversation } from '@/features/chat/types'
import { useLayoutStore } from '@/features/layout'
import { Providers } from './providers'

vi.mock('@/adapters/api', () => ({
  ApiRequestError: class ApiRequestError extends Error {},
  fetchDataSources: vi.fn(),
  getJobStatus: vi.fn(),
  submitJob: vi.fn(),
}))

const initialChat = useChatStore.getState()
const SPEECH_OFF = { enabled: false, maxSeconds: 60 }
const initialLayout = useLayoutStore.getState()

/** Saves a live session whose job was running when the page closed, then reloads the store. */
const loadSavedSessionWithRunningJob = async (): Promise<void> => {
  const saved: Conversation = {
    id: 's_saved',
    userId: 'local',
    title: 'Which assets led?',
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [
      {
        id: 'question',
        role: 'user',
        content: 'Which assets led?',
        timestamp: new Date(),
        messageType: 'user',
      },
      {
        id: 'answer',
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        messageType: 'agent_response',
        deepResearchJobId: 'job-1',
        deepResearchJobStatus: 'running',
        isDeepResearchActive: true,
      },
    ],
  }
  useChatStore.setState({ currentUserId: 'local', conversations: [saved] })
  await useChatStore.persist.rehydrate()
}

const savedJobStatus = () =>
  useChatStore.getState().conversations[0]?.messages[1]?.deepResearchJobStatus

describe('Providers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchDataSources).mockResolvedValue([{ id: 'market_news', name: 'News' }])
    useChatStore.setState(initialChat, true)
    useLayoutStore.setState(initialLayout, true)
  })

  test('live mode selects the local user and loads the data sources', async () => {
    render(
      <Providers config={{ mode: 'live', phoenixUrl: null, speechInput: SPEECH_OFF }}>
        content
      </Providers>
    )

    await waitFor(() =>
      expect(useLayoutStore.getState().availableDataSources).toEqual([
        { id: 'market_news', name: 'News' },
      ])
    )
    expect(useChatStore.getState().currentUserId).toBe('local')
  })

  test('live mode settles saved jobs that ended while the page was closed', async () => {
    vi.mocked(getJobStatus).mockResolvedValue({ job_id: 'job-1', status: 'failure', error: null })
    await loadSavedSessionWithRunningJob()

    render(
      <Providers config={{ mode: 'live', phoenixUrl: null, speechInput: SPEECH_OFF }}>
        content
      </Providers>
    )

    await waitFor(() => expect(savedJobStatus()).toBe('failure'))
    expect(getJobStatus).toHaveBeenCalledWith('job-1')
  })

  test('a question asked from a new draft is not looked up before the API admits its job', async () => {
    // The API does not know the job until its submission returns (404 before)
    let admit = (): void => {}
    vi.mocked(submitJob).mockImplementation(
      ({ jobId }) =>
        new Promise((resolve) => {
          admit = () => resolve({ job_id: jobId, status: 'submitted' })
        })
    )
    vi.mocked(getJobStatus).mockRejectedValue(new Error('Failed to get job status: 404'))
    let ask: (question: string) => void = () => {}
    const Asker = () => {
      ask = useHermesChat().sendMessage
      return null
    }
    render(
      <Providers config={{ mode: 'live', phoenixUrl: null, speechInput: SPEECH_OFF }}>
        <Asker />
      </Providers>
    )
    await waitFor(() => expect(useChatStore.getState().currentUserId).toBe('local'))

    // A landing card's question: the session is created by Run, which restores its jobs
    act(() => ask('Which assets led?'))
    await act(async () => {})

    expect(getJobStatus).not.toHaveBeenCalled()
    await act(async () => admit())
    const state = useChatStore.getState()
    expect(state.isDeepResearchStreaming).toBe(true)
    expect(state.submittingJobIds).toEqual([])
    expect(
      state.currentConversation?.messages.map(
        (m) => m.deepResearchBannerData?.bannerType ?? m.messageType
      )
    ).toEqual(['user', 'agent_response', 'starting'])
  })

  test('replay mode never calls the API, even for saved live jobs', async () => {
    await loadSavedSessionWithRunningJob()

    render(
      <Providers config={{ mode: 'replay', phoenixUrl: null, speechInput: SPEECH_OFF }}>
        content
      </Providers>
    )

    await waitFor(() => expect(useChatStore.getState().currentUserId).toBe('local'))
    expect(fetchDataSources).not.toHaveBeenCalled()
    expect(getJobStatus).not.toHaveBeenCalled()
    expect(savedJobStatus()).toBe('running')
  })
})
