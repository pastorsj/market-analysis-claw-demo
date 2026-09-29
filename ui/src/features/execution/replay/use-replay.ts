// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The replay cursor: how many of the run's events are shown. By default it
 * follows the latest event, so a live run keeps growing; play, pause and seek
 * step through the events one at a time.
 */

import { useEffect, useState } from 'react'

const STEP_MS = 650

export interface Replay {
  /** Events shown: 0..total */
  step: number
  total: number
  playing: boolean
  play: () => void
  pause: () => void
  seek: (step: number) => void
}

export const useReplay = (total: number): Replay => {
  // null follows the latest event
  const [pinned, setPinned] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const step = Math.min(pinned ?? total, total)

  useEffect(() => {
    if (!playing) return
    if (step >= total) {
      setPlaying(false)
      setPinned(null)
      return
    }
    const timer = setTimeout(() => setPinned(step + 1), STEP_MS)
    return () => clearTimeout(timer)
  }, [playing, step, total])

  return {
    step,
    total,
    playing,
    play: () => {
      if (step >= total) setPinned(0)
      setPlaying(true)
    },
    pause: () => setPlaying(false),
    seek: (next) => {
      setPlaying(false)
      setPinned(next >= total ? null : Math.max(0, next))
    },
  }
}
