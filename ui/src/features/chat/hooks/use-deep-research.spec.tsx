// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getJobReport, getJobStatus } from '@/adapters/api'
import { useLayoutStore } from '@/features/layout/store'
import { ExecutionFeatureProvider, noExecutionFeature } from '@/shared/context'
import { FakeEventSource } from '@/test-utils/fake-event-source'
import { useChatStore } from '../store'
import { useDeepResearch } from './use-deep-research'

vi.mock('@/adapters/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/adapters/api')>()),
  getJobReport: vi.fn(),
  getJobStatus: vi.fn(),
}))

const initialChat = useChatStore.getState()
const initialLayout = useLayoutStore.getState()
const chat = () => useChatStore.getState()

const onJobEvent = vi.fn()
const wrapper = ({ children }: { children: ReactNode }) => (
  <ExecutionFeatureProvider feature={{ ...noExecutionFeature, onJobEvent }}>
    {children}
  </ExecutionFeatureProvider>
)

/** Start following job-1 and return its stream once connected. */
const followJob = (): FakeEventSource => {
  chat().ensureSession()
  chat().addUserMessage('Which assets led?')
  const messageId = chat().addAgentResponseWithMeta('', {
    deepResearchJobId: 'job-1',
    deepResearchJobStatus: 'submitted',
    isDeepResearchActive: true,
  })
  chat().startDeepResearch('job-1', messageId)
  renderHook(() => useDeepResearch(), { wrapper })
  act(() => {
    vi.advanceTimersByTime(50)
  })
  return FakeEventSource.latest
}

describe('useDeepResearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    useChatStore.setState(initialChat, true)
    useLayoutStore.setState(initialLayout, true)
    chat().setCurrentUser('local')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test('does not connect without a running job', () => {
    renderHook(() => useDeepResearch(), { wrapper })
    act(() => {
      vi.advanceTimersByTime(50)
    })

    expect(FakeEventSource.instances).toEqual([])
  })

  test('forwards every record to the execution view', () => {
    const stream = followJob()

    act(() => stream.emit('execution.v2', { eventKind: 'run.started' }, '1'))

    expect(stream.url).toBe('/api/v1/jobs/async/job/job-1/stream')
    expect(onJobEvent).toHaveBeenCalledWith({
      jobId: 'job-1',
      cursor: '1',
      type: 'execution.v2',
      data: { eventKind: 'run.started' },
    })
  })

  test('settles the answer when the job succeeds', () => {
    const stream = followJob()

    act(() => {
      stream.emit('job.status', { status: 'running' })
      stream.emit('artifact.update', {
        data: { type: 'output', output_category: 'final_report', content: '# Answer' },
      })
      stream.emit('job.status', { status: 'success' })
    })

    const answer = chat().currentConversation?.messages.at(-1)
    expect(answer).toMatchObject({ content: '# Answer', deepResearchJobStatus: 'success' })
    expect(chat().isDeepResearchStreaming).toBe(false)
  })

  test('fails the run when the API stays unreachable after the stream broke', async () => {
    vi.mocked(getJobStatus).mockRejectedValue(new TypeError('Failed to fetch'))
    const stream = followJob()

    act(() => stream.fail(FakeEventSource.CLOSED))
    await act(() => vi.advanceTimersByTimeAsync(7_000))

    expect(getJobStatus).toHaveBeenCalledTimes(4)
    expect(chat().deepResearchStatus).toBe('failure')
    expect(chat().currentConversation?.messages.at(-1)?.errorData?.errorMessage).toMatch(
      /Lost connection to the run/
    )
  })

  test('a broken stream saves nothing before the API answers, so a reload can follow the run', async () => {
    vi.mocked(getJobStatus).mockReturnValue(new Promise(() => {})) // the page is gone first
    const stream = followJob()

    act(() => stream.fail(FakeEventSource.CLOSED))
    await act(() => vi.advanceTimersByTimeAsync(10_000))

    const answer = chat().currentConversation?.messages.find(
      (m) => m.messageType === 'agent_response'
    )
    expect(answer).toMatchObject({ deepResearchJobStatus: 'submitted', isDeepResearchActive: true })
    expect(chat().isDeepResearchStreaming).toBe(true)
  })

  test('follows the job again when its stream broke while it still runs', async () => {
    vi.mocked(getJobStatus).mockResolvedValue({ job_id: 'job-1', status: 'running', error: null })
    const stream = followJob()

    act(() => stream.fail(FakeEventSource.CLOSED))
    await act(() => vi.advanceTimersByTimeAsync(0))

    expect(FakeEventSource.instances).toHaveLength(2)
    const again = FakeEventSource.latest
    act(() => {
      again.emit('artifact.update', {
        data: { type: 'output', output_category: 'final_report', content: '# Answer' },
      })
      again.emit('job.status', { status: 'success' })
    })
    expect(chat().currentConversation?.messages.at(-1)).toMatchObject({
      content: '# Answer',
      deepResearchJobStatus: 'success',
    })
  })

  test('settles a job that ended while its stream was broken, with its report', async () => {
    vi.mocked(getJobStatus).mockResolvedValue({ job_id: 'job-1', status: 'success', error: null })
    vi.mocked(getJobReport).mockResolvedValue({
      job_id: 'job-1',
      has_report: true,
      report: '# Answer',
    })
    const stream = followJob()

    act(() => stream.fail(FakeEventSource.CLOSED))
    await act(() => vi.advanceTimersByTimeAsync(0))

    expect(chat().isDeepResearchStreaming).toBe(false)
    expect(chat().currentConversation?.messages.at(-1)).toMatchObject({
      content: '# Answer',
      deepResearchJobStatus: 'success',
    })
  })
})
