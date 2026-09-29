// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '@/features/chat'
import { useAppConfig, useExecutionFeature, type RecordedSessionSummary } from '@/shared/context'

interface UseRecordedSessionsReturn {
  /** Recorded sessions of the active data pack (empty outside replay mode) */
  sessions: RecordedSessionSummary[]
  /** Load a recorded session and show it as a read-only conversation */
  open: (sessionId: string) => Promise<void>
}

/** Recorded sessions, provided by the execution feature's recordings source in replay mode. */
export const useRecordedSessions = (): UseRecordedSessionsReturn => {
  const { mode } = useAppConfig()
  const { recordings } = useExecutionFeature()
  const [sessions, setSessions] = useState<RecordedSessionSummary[]>([])

  useEffect(() => {
    if (mode !== 'replay' || !recordings) return
    let cancelled = false
    recordings
      .list()
      .then((list) => {
        if (!cancelled) setSessions(list)
      })
      .catch((error: unknown) => console.error('Failed to list recorded sessions:', error))
    return () => {
      cancelled = true
    }
  }, [mode, recordings])

  const open = useCallback(
    async (sessionId: string) => {
      if (!recordings) return
      try {
        useChatStore.getState().openRecordedSession(await recordings.load(sessionId))
      } catch (error) {
        console.error('Failed to load recorded session:', error)
      }
    },
    [recordings]
  )

  return { sessions, open }
}
