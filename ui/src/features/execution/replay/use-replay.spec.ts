// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReplay } from './use-replay'

describe('useReplay', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('follows the latest event until the user seeks', () => {
    const { result, rerender } = renderHook(({ total }) => useReplay(total), {
      initialProps: { total: 3 },
    })
    expect(result.current.step).toBe(3)
    rerender({ total: 5 })
    expect(result.current.step).toBe(5)

    act(() => result.current.seek(2))
    rerender({ total: 6 })
    expect(result.current.step).toBe(2)
  })

  it('plays from the start one event at a time, then follows again', () => {
    const { result, rerender } = renderHook(({ total }) => useReplay(total), {
      initialProps: { total: 2 },
    })
    act(() => result.current.play())
    expect(result.current).toMatchObject({ step: 0, playing: true })
    act(() => vi.advanceTimersByTime(650))
    expect(result.current.step).toBe(1)
    act(() => vi.advanceTimersByTime(650))
    act(() => vi.advanceTimersByTime(650))
    expect(result.current).toMatchObject({ step: 2, playing: false })
    rerender({ total: 3 })
    expect(result.current.step).toBe(3)
  })
})
