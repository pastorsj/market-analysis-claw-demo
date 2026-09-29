// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useChatStore } from '@/features/chat'
import type { ActivityPanelProps } from '@/shared/context'
import { useLayoutStore } from '../store'
import { ResearchPanel } from './ResearchPanel'

const initialLayout = useLayoutStore.getState()
const initialChat = useChatStore.getState()

const ActivityPanel = ({ jobId }: ActivityPanelProps) => <p>Activity for {jobId}</p>

describe('ResearchPanel', () => {
  beforeEach(() => {
    useLayoutStore.setState(initialLayout, true)
    useChatStore.setState(initialChat, true)
  })

  test('renders nothing without an execution activity panel', () => {
    render(<ResearchPanel />)

    expect(screen.queryByTestId('research-panel-toggle')).not.toBeInTheDocument()
  })

  test('shows the activity panel for the current job when opened', async () => {
    useChatStore.setState({ deepResearchJobId: 'job-1' })
    render(<ResearchPanel />, { feature: { ActivityPanel } })

    await userEvent.click(screen.getByRole('button', { name: 'Open agent activity panel' }))

    expect(screen.getByText('Agent Activity')).toBeInTheDocument()
    expect(screen.getByText('Activity for job-1')).toBeInTheDocument()
  })

  test('stops the running job', async () => {
    const cancelActiveDeepResearchJob = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({ isDeepResearchStreaming: true, cancelActiveDeepResearchJob })
    useLayoutStore.setState({ rightPanel: 'research' })
    render(<ResearchPanel />, { feature: { ActivityPanel } })

    await userEvent.click(screen.getByRole('button', { name: 'Stop run' }))

    expect(cancelActiveDeepResearchJob).toHaveBeenCalledOnce()
  })
})
