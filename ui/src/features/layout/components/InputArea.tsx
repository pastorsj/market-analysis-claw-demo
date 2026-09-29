// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * InputArea Component
 *
 * Chat input area at the bottom of the chat view: the question, the data
 * source indicator, and send (or stop while a run is in progress).
 */

'use client'

import { type FC, memo, useState, useCallback, useEffect, type KeyboardEvent } from 'react'
import { Flex, Text, Button, TextArea } from '@/adapters/ui'
import { useHermesChat, useChatStore, useIsCurrentSessionBusy } from '@/features/chat'
import { useLayoutStore } from '../store'
import { Globe, Paperplane, StopCircle } from '@/adapters/ui/icons'

interface InputAreaProps {
  /** Placeholder text */
  placeholder?: string
}

/**
 * Chat input component with text area and action buttons.
 * Positioned at the bottom of the chat area.
 */
export const InputArea: FC<InputAreaProps> = memo(function InputArea({
  placeholder = 'Check data sources and ask a research question...',
}) {
  const [message, setMessage] = useState('')
  const { sendMessage, stop } = useHermesChat()

  // A running job in this session pauses the composer; it can be stopped.
  const isBusy = useIsCurrentSessionBusy()

  const currentConversation = useChatStore((state) => state.currentConversation)
  const ensureSession = useChatStore((state) => state.ensureSession)

  const enabledDataSourceIds = useLayoutStore((s) => s.enabledDataSourceIds)
  const availableDataSources = useLayoutStore((s) => s.availableDataSources)
  const promptDraft = useLayoutStore((s) => s.promptDraft)
  const setPromptDraft = useLayoutStore((s) => s.setPromptDraft)

  // Prefill the composer from a staged prompt (e.g. a featured question)
  useEffect(() => {
    if (promptDraft) {
      setMessage(promptDraft)
      setPromptDraft(null)
    }
  }, [promptDraft, setPromptDraft])

  const handleSubmit = useCallback(() => {
    if (!message.trim() || isBusy) return
    // Session creation needs the user ID, which is set at startup.
    if (!ensureSession()) return
    setMessage('')
    sendMessage(message)
  }, [message, isBusy, ensureSession, sendMessage])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  const handleValueChange = useCallback(
    (value: string) => {
      // Persist a session as soon as the user starts typing. This keeps
      // logo-triggered "new session" drafts out of history until touched.
      if (!currentConversation && value.trim().length > 0) {
        ensureSession()
      }
      setMessage(value)
    },
    [currentConversation, ensureSession]
  )

  const toggleDataSources = useCallback(() => {
    const { rightPanel, closeRightPanel, openRightPanel } = useLayoutStore.getState()
    if (rightPanel === 'data-sources') {
      closeRightPanel()
    } else {
      openRightPanel('data-sources')
    }
  }, [])

  return (
    <Flex direction="col" className="mx-auto w-full max-w-4xl px-6 py-4">
      <Flex
        direction="col"
        className="composer-surface relative rounded-[var(--radius-composer)] border p-3.5 transition-colors"
      >
        {/* Text Input */}
        <div onKeyDown={handleKeyDown}>
          <TextArea
            className="composer-textarea border-0 bg-transparent"
            value={message}
            onValueChange={handleValueChange}
            placeholder={isBusy ? 'Please wait...' : placeholder}
            disabled={isBusy}
            resizeable="auto"
            size="medium"
            aria-label="Chat message input"
          />
        </div>

        {/* Bottom Actions Bar */}
        <Flex align="center" justify="end" gap="1.5" className="border-base mt-3 border-t pt-3">
          {/* Sources indicator - clickable to toggle data connections */}
          <Button
            kind="tertiary"
            size="tiny"
            onClick={toggleDataSources}
            tabIndex={-1}
            aria-label="Toggle data sources connections"
            title="Selected data connections"
          >
            <Flex align="center" gap="1">
              <Globe className="h-3 w-3" />
              <Text kind="label/bold/sm">
                {enabledDataSourceIds.length}/{availableDataSources?.length ?? 0}
              </Text>
            </Flex>
          </Button>

          {isBusy ? (
            <Button
              kind="secondary"
              size="small"
              color="danger"
              onClick={stop}
              aria-label="Stop generating"
              title="Stop generating"
            >
              <StopCircle className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              kind="primary"
              size="small"
              color={message.trim() ? 'brand' : undefined}
              onClick={handleSubmit}
              disabled={!message.trim()}
              aria-label="Send message"
              title="Send query"
            >
              <Paperplane className="h-4 w-4" />
            </Button>
          )}
        </Flex>
      </Flex>
    </Flex>
  )
})
