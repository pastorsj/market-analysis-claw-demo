// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ResearchPanel Component
 *
 * Right-side "Agent Activity" panel. Its content comes from the execution
 * feature; without one the panel is not rendered.
 *
 * This panel PUSHES the chat area (takes 60% width) rather than overlaying it.
 */

'use client'

import { type FC, memo, useCallback } from 'react'
import { Flex, Button, Spinner, Text } from '@/adapters/ui'
import { Close, Generate, StopCircle } from '@/adapters/ui/icons'
import { useChatStore } from '@/features/chat'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useExecutionFeature } from '@/shared/context'
import { useLayoutStore } from '../store'

export const ResearchPanel: FC = memo(function ResearchPanel() {
  const { ActivityPanel } = useExecutionFeature()
  const isOpen = useLayoutStore((s) => s.rightPanel === 'research')
  const closeRightPanel = useLayoutStore((s) => s.closeRightPanel)
  const openRightPanel = useLayoutStore((s) => s.openRightPanel)
  const isDeepResearchStreaming = useChatStore((state) => state.isDeepResearchStreaming)
  const jobId = useChatStore((state) => state.deepResearchJobId)
  const prefersReducedMotion = useReducedMotion()

  const handleToggle = useCallback(() => {
    if (isOpen) {
      closeRightPanel()
    } else {
      openRightPanel('research')
    }
  }, [isOpen, closeRightPanel, openRightPanel])

  const handleStop = useCallback(() => {
    useChatStore
      .getState()
      .cancelActiveDeepResearchJob()
      .catch((error: unknown) => console.error('Failed to cancel job:', error))
  }, [])

  if (!ActivityPanel) return null

  return (
    <div
      className="relative flex h-full"
      style={{
        width: isOpen ? 'calc(60% + 40px)' : '40px',
        minWidth: isOpen ? 'calc(60% + 40px)' : '40px',
        transition: prefersReducedMotion
          ? 'none'
          : 'width 600ms ease-in-out, min-width 600ms ease-in-out',
      }}
    >
      <button
        onClick={handleToggle}
        className="research-panel-toggle border-base bg-surface-base relative z-10 flex w-10 shrink-0 cursor-pointer items-center justify-center self-start overflow-hidden rounded-bl-lg border-b border-l border-r border-t transition-colors hover:border-[#76B900]"
        style={{ height: 'calc(var(--spacing) * 38)' }}
        aria-label={isOpen ? 'Close agent activity panel' : 'Open agent activity panel'}
        aria-expanded={isOpen}
        title={isOpen ? 'Close agent activity panel' : 'Open agent activity panel'}
        data-testid="research-panel-toggle"
      >
        <span
          className="absolute left-1/2 flex -translate-x-1/2 items-center justify-center"
          style={{
            top: 'calc(var(--spacing) * 3)',
            width: 'calc(var(--spacing) * 6)',
            height: 'calc(var(--spacing) * 6)',
          }}
        >
          {isDeepResearchStreaming ? (
            <Spinner size="small" aria-label="Thinking" />
          ) : (
            <Generate className="h-[calc(var(--spacing)*6)] w-[calc(var(--spacing)*6)]" />
          )}
        </span>
        <Text
          kind="label/semibold/sm"
          className="text-primary absolute left-1/2 -translate-x-1/2 -rotate-90 whitespace-nowrap"
          style={{ top: 'calc(var(--spacing) * 21)' }}
        >
          Show Activity
        </Text>
      </button>

      <div
        className={`border-base bg-surface-base -ml-px h-full flex-1 overflow-hidden rounded-bl-xl ${
          isOpen ? 'border-l' : ''
        }`}
        aria-hidden={!isOpen}
      >
        <Flex
          direction="col"
          className="h-full w-full"
          style={{
            visibility: isOpen ? 'visible' : 'hidden',
            opacity: isOpen ? 1 : 0,
            transition: prefersReducedMotion
              ? 'none'
              : isOpen
                ? 'opacity 100ms ease-in-out, visibility 0ms'
                : 'opacity 100ms ease-in-out 500ms, visibility 0ms 600ms',
          }}
        >
          <Flex
            align="center"
            justify="between"
            className="border-base shrink-0 border-b py-4 pl-6 pr-8"
          >
            <Flex direction="col" gap="0.5">
              <Text kind="label/semibold/lg" className="text-primary">
                Agent Activity
              </Text>
              <Text kind="body/regular/xs" className="text-secondary">
                Live narrative and completed timing
              </Text>
            </Flex>
            <Flex align="center" gap="2">
              {isDeepResearchStreaming ? (
                <Button
                  kind="tertiary"
                  size="small"
                  onClick={handleStop}
                  aria-label="Stop run"
                  title="Stop run"
                  data-testid="research-panel-stop"
                >
                  <StopCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                  Stop
                </Button>
              ) : null}
              <Button
                kind="tertiary"
                size="small"
                onClick={closeRightPanel}
                aria-label="Close agent activity panel"
                title="Close agent activity panel"
                data-testid="research-panel-close"
              >
                <Close className="h-4 w-4" aria-hidden="true" />
              </Button>
            </Flex>
          </Flex>

          <Flex direction="col" className="min-h-0 flex-1 overflow-hidden py-4 pl-6 pr-8">
            {isOpen ? <ActivityPanel jobId={jobId} /> : null}
          </Flex>
        </Flex>
      </div>
    </div>
  )
})
