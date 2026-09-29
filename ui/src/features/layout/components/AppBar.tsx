// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AppBar Component
 *
 * Top navigation bar with the logo (new session), session title, and actions:
 * data sources, the Phoenix trace viewer (when configured), and theme.
 */

'use client'

import { type FC, memo, useCallback, useEffect, useState } from 'react'
import { Flex, Text, Button, Logo, Divider } from '@/adapters/ui'
import { Globe, Moon, OpenExternal, Sun } from '@/adapters/ui/icons'
import { useAppConfig } from '@/shared/context'
import { useLayoutStore } from '../store'
import { cn } from '@/shared/lib/cn'

interface AppBarProps {
  /** Current session title to display */
  sessionTitle?: string
  /** Callback when a new session is requested */
  onNewSession?: () => void
  /** Accessible copy for the logo action when it changes context */
  newSessionActionLabel?: string
  /** Disable creating a new session while a question is being submitted */
  isNewSessionDisabled?: boolean
  /** Show the data sources action (hidden in replay mode) */
  showDataSources?: boolean
}

/**
 * Main navigation bar at the top of the application.
 */
export const AppBar: FC<AppBarProps> = memo(function AppBar({
  sessionTitle = '',
  onNewSession,
  newSessionActionLabel = 'Create new session',
  isNewSessionDisabled = false,
  showDataSources = true,
}) {
  const { phoenixUrl } = useAppConfig()
  const rightPanel = useLayoutStore((s) => s.rightPanel)
  const isDataSourcesOpen = rightPanel === 'data-sources'
  const theme = useLayoutStore((s) => s.theme)
  const setTheme = useLayoutStore((s) => s.setTheme)
  const [systemPrefersDark, setSystemPrefersDark] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemPrefersDark(mq.matches)
    const handler = (e: MediaQueryListEvent): void => setSystemPrefersDark(e.matches)
    mq.addEventListener?.('change', handler)
    return () => mq.removeEventListener?.('change', handler)
  }, [])

  const isDarkMode = theme === 'dark' || (theme === 'system' && systemPrefersDark)
  const toggleTheme = useCallback(() => {
    setTheme(isDarkMode ? 'light' : 'dark')
  }, [isDarkMode, setTheme])

  const handleAddSourcesClick = useCallback(() => {
    const { rightPanel, closeRightPanel, openRightPanel } = useLayoutStore.getState()
    if (rightPanel === 'data-sources') {
      closeRightPanel()
    } else {
      openRightPanel('data-sources')
    }
  }, [])

  const handleNewSessionClick = useCallback(() => {
    if (isNewSessionDisabled) return
    onNewSession?.()
  }, [isNewSessionDisabled, onNewSession])

  return (
    <header className="border-base border-b">
      <Flex align="center" justify="between" className="h-[var(--header-height)] gap-4 px-4">
        {/* Left section: New session button + session title */}
        <Flex align="center" gap="2" className="min-w-0 flex-1">
          <Button
            kind="tertiary"
            size="small"
            onClick={handleNewSessionClick}
            disabled={isNewSessionDisabled}
            aria-label={newSessionActionLabel}
            title={
              isNewSessionDisabled
                ? 'Cannot create new session while an answer is running'
                : newSessionActionLabel
            }
          >
            <Logo kind="logo-only" size="small" />
          </Button>
          {sessionTitle && (
            <Flex justify="start">
              <Divider orientation="vertical" />
            </Flex>
          )}
          <div className="ml-4 hidden min-w-0 flex-1 items-center md:flex">
            <Text
              kind="body/regular/md"
              className="text-subtle block w-full max-w-[360px] truncate lg:max-w-[480px] xl:max-w-[560px]"
            >
              {sessionTitle}
            </Text>
          </div>
        </Flex>

        {/* Right section: Actions */}
        <Flex align="center" gap="2" className="shrink-0">
          {showDataSources && (
            <Button
              kind="tertiary"
              size="small"
              onClick={handleAddSourcesClick}
              aria-label="Add data sources"
              aria-pressed={isDataSourcesOpen}
              title="Add data sources"
              className={cn(isDataSourcesOpen && 'brand-tint')}
            >
              <Flex align="center" gap="1">
                <Globe className="h-4 w-4" />
                <Text kind="label/regular/md">Data Sources</Text>
              </Flex>
            </Button>
          )}

          {phoenixUrl && (
            <a
              href={phoenixUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open Phoenix observability"
              title="Open Phoenix observability"
              data-testid="phoenix-observability-link"
              className="text-primary hover:bg-raised focus-visible:ring-brand inline-flex h-8 cursor-pointer items-center gap-1 rounded px-2 no-underline transition-colors focus-visible:outline-none focus-visible:ring-2"
            >
              <OpenExternal className="h-4 w-4" width={16} height={16} />
              <Text kind="label/regular/md">Phoenix</Text>
            </a>
          )}

          {/* Theme toggle: quick dark/light switch */}
          <Button
            kind="tertiary"
            size="small"
            onClick={toggleTheme}
            aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDarkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </Flex>
      </Flex>
    </header>
  )
})
