// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * InputArea Component
 *
 * Chat input area at the bottom of the chat view: the question, the
 * microphone when voice input is on, the data source indicator, and send (or
 * stop while a run is in progress).
 */

'use client'

import { type FC, memo, useState, useCallback, useEffect, useRef, type KeyboardEvent } from 'react'
import { Banner, Flex, Text, Button, TextArea } from '@/adapters/ui'
import { useHermesChat, useChatStore, useIsCurrentSessionBusy } from '@/features/chat'
import {
  getSpeechInputStatusMessage,
  SpeechInputButton,
  useSpeechInput,
} from '@/features/speech-input'
import { useAppConfig } from '@/shared/context'
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
  // The latest draft, for a transcript that arrives after the user typed more
  const messageRef = useRef('')
  const textAreaRef = useRef<HTMLTextAreaElement>(null)
  const speechInsertionRef = useRef({ start: 0, end: 0 })
  const { sendMessage, stop } = useHermesChat()
  const { speechInput: speechInputConfig } = useAppConfig()

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
      messageRef.current = promptDraft
      setMessage(promptDraft)
      setPromptDraft(null)
    }
  }, [promptDraft, setPromptDraft])

  const handleSubmit = useCallback(() => {
    if (!message.trim() || isBusy) return
    // Session creation needs the user ID, which is set at startup.
    if (!ensureSession()) return
    messageRef.current = ''
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
      messageRef.current = value
      setMessage(value)
    },
    [currentConversation, ensureSession]
  )

  const rememberSpeechInsertionPoint = useCallback(() => {
    const textArea = textAreaRef.current
    if (!textArea) {
      speechInsertionRef.current = { start: message.length, end: message.length }
      return
    }
    speechInsertionRef.current = {
      start: textArea.selectionStart ?? message.length,
      end: textArea.selectionEnd ?? message.length,
    }
  }, [message.length])

  const insertSpeechTranscript = useCallback(
    (transcript: string) => {
      const spokenText = transcript.trim()
      if (!spokenText) return
      if (!currentConversation) ensureSession()

      // Transcription is asynchronous and the composer stays editable while it
      // runs: insert into the latest draft so a late result never overwrites
      // text typed meanwhile.
      const currentMessage = messageRef.current
      const start = Math.min(currentMessage.length, Math.max(0, speechInsertionRef.current.start))
      const end = Math.min(currentMessage.length, Math.max(start, speechInsertionRef.current.end))
      const before = currentMessage.slice(0, start)
      const after = currentMessage.slice(end)
      const leadingSpace = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
      const trailingSpace = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
      const nextMessage = `${before}${leadingSpace}${spokenText}${trailingSpace}${after}`
      const nextCursor = before.length + leadingSpace.length + spokenText.length

      messageRef.current = nextMessage
      setMessage(nextMessage)
      speechInsertionRef.current = { start: nextCursor, end: nextCursor }
      window.requestAnimationFrame(() => {
        textAreaRef.current?.focus()
        textAreaRef.current?.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [currentConversation, ensureSession]
  )

  const speechInput = useSpeechInput({
    enabled: speechInputConfig.enabled && !isBusy,
    maxSeconds: speechInputConfig.maxSeconds,
    onTranscript: insertSpeechTranscript,
  })

  const handleSpeechToggle = useCallback(() => {
    if (speechInput.state === 'recording') {
      void speechInput.stop()
      return
    }
    void speechInput.start()
  }, [speechInput])

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
            ref={textAreaRef}
            className="composer-textarea border-0 bg-transparent"
            value={message}
            onValueChange={handleValueChange}
            onSelect={rememberSpeechInsertionPoint}
            placeholder={isBusy ? 'Please wait...' : placeholder}
            disabled={isBusy}
            resizeable="auto"
            size="medium"
            aria-label="Chat message input"
            slotRight={
              speechInputConfig.enabled ? (
                <SpeechInputButton
                  state={speechInput.state}
                  disabled={isBusy}
                  onBeforeToggle={rememberSpeechInsertionPoint}
                  onToggle={handleSpeechToggle}
                />
              ) : undefined
            }
          />
        </div>

        {speechInputConfig.enabled && (
          <span className="sr-only" role="status" aria-live="polite">
            {getSpeechInputStatusMessage(speechInput.state)}
          </span>
        )}

        {speechInput.error && (
          <Banner kind="inline" status="error" onClose={speechInput.clearError} className="mt-2">
            {speechInput.error}
          </Banner>
        )}

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
