// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useChatStore } from '@/features/chat'
import { useLayoutStore } from '../store'
import { InputArea } from './InputArea'

const hermes = vi.hoisted(() => ({ sendMessage: vi.fn(), stop: vi.fn() }))
const speech = vi.hoisted(() => ({
  transcribe: vi.fn(),
  recorder: { start: vi.fn(), stop: vi.fn(), cancel: vi.fn() },
}))

vi.mock('@/features/chat/hooks/use-hermes-chat', () => ({ useHermesChat: () => hermes }))
vi.mock('@/adapters/api/speech-client', () => ({ transcribeSpeech: speech.transcribe }))
vi.mock('@/features/speech-input/browser-recorder', () => ({
  createBrowserSpeechRecorder: () => speech.recorder,
}))

const VOICE = { speechInput: { enabled: true, maxSeconds: 60 } }

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
          { id: 'market_analysis_structured', name: 'Market data', kind: 'structured' },
          { id: 'market_news', name: 'Market news', kind: 'documents' },
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

  test('counts the enabled database connections, as the original UI did', () => {
    const { rerender } = render(<InputArea />)
    const counter = screen.getByRole('button', { name: 'Toggle data sources connections' })
    expect(counter).toHaveTextContent('1/1')

    // A document collection is not a database connection
    useLayoutStore.setState({ enabledDataSourceIds: ['market_news'] })
    rerender(<InputArea />)
    expect(counter).toHaveTextContent('0/1')
  })

  test('has no microphone unless voice input is on', () => {
    render(<InputArea />)

    expect(screen.queryByRole('button', { name: 'Start voice input' })).toBeNull()
  })

  test('replay shows the read-only composer with a disabled microphone', () => {
    render(<InputArea />, { config: { mode: 'replay' } })

    expect(screen.getByRole('textbox', { name: 'Chat message input' })).toHaveAttribute(
      'placeholder',
      'Recorded test sessions are read only'
    )
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeDisabled()
  })

  test('records a question and inserts its transcript where the cursor was', async () => {
    speech.recorder.start.mockResolvedValue(undefined)
    speech.recorder.stop.mockResolvedValue(new Blob([new Uint8Array(64)], { type: 'audio/wav' }))
    speech.recorder.cancel.mockResolvedValue(undefined)
    speech.transcribe.mockResolvedValue({ text: 'had the strongest returns' })
    render(<InputArea />, { config: VOICE })
    const input = screen.getByRole('textbox', { name: 'Chat message input' })
    await userEvent.type(input, 'Which assets over the summer?')
    ;(input as HTMLTextAreaElement).setSelectionRange(12, 12)

    await userEvent.click(screen.getByRole('button', { name: 'Start voice input' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Stop voice recording' }))

    await vi.waitFor(() =>
      expect(input).toHaveValue('Which assets had the strongest returns over the summer?')
    )
    expect(speech.transcribe).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeEnabled()
  })

  test('shows a transcription failure without losing the draft', async () => {
    speech.recorder.start.mockResolvedValue(undefined)
    speech.recorder.stop.mockResolvedValue(new Blob([new Uint8Array(64)], { type: 'audio/wav' }))
    speech.transcribe.mockRejectedValue({
      userMessage: 'Voice transcription is busy. Wait a moment and try again.',
    })
    render(<InputArea />, { config: VOICE })
    await userEvent.type(screen.getByRole('textbox', { name: 'Chat message input' }), 'Draft')

    await userEvent.click(screen.getByRole('button', { name: 'Start voice input' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Stop voice recording' }))

    expect(
      await screen.findByText('Voice transcription is busy. Wait a moment and try again.')
    ).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).toHaveValue('Draft')
  })
})
