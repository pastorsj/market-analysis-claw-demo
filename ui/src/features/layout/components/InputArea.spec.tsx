// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useChatStore } from '@/features/chat'
import { useLayoutStore } from '../store'
import { InputArea } from './InputArea'

const hermes = vi.hoisted(() => ({ sendMessage: vi.fn(), stop: vi.fn() }))

vi.mock('@/features/chat/hooks/use-hermes-chat', () => ({ useHermesChat: () => hermes }))

const initialChat = useChatStore.getState()
const initialLayout = useLayoutStore.getState()

describe('InputArea', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState(initialChat, true)
    useChatStore.getState().setCurrentUser('local')
    useLayoutStore.setState(
      {
        ...initialLayout,
        availableDataSources: [
          { id: 'market_analysis_structured', name: 'Market data' },
          { id: 'market_news', name: 'Market news' },
        ],
        enabledDataSourceIds: ['market_analysis_structured'],
      },
      true
    )
  })

  test('sends the question on Enter and clears the composer', async () => {
    render(<InputArea />)
    const input = screen.getByRole('textbox', { name: 'Chat message input' })

    await userEvent.type(input, 'Which assets led?{Enter}')

    expect(hermes.sendMessage).toHaveBeenCalledWith('Which assets led?')
    expect(input).toHaveValue('')
    expect(useChatStore.getState().currentConversation).not.toBeNull()
  })

  test('disables sending an empty question', () => {
    render(<InputArea />)

    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  })

  test('offers to stop while a run is in progress', async () => {
    useChatStore.setState({ isStreaming: true })
    render(<InputArea />)

    expect(screen.getByRole('textbox', { name: 'Chat message input' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Stop generating' }))
    expect(hermes.stop).toHaveBeenCalledOnce()
  })

  test('prefills the composer from a staged prompt', () => {
    useLayoutStore.setState({ promptDraft: 'A featured question' })
    render(<InputArea />)

    expect(screen.getByRole('textbox', { name: 'Chat message input' })).toHaveValue(
      'A featured question'
    )
    expect(useLayoutStore.getState().promptDraft).toBeNull()
  })

  test('shows how many data sources are enabled', () => {
    render(<InputArea />)

    expect(
      screen.getByRole('button', { name: 'Toggle data sources connections' })
    ).toHaveTextContent('1/2')
  })
})
