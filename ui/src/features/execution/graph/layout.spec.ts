// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { layeredLayout } from './layout'

describe('layeredLayout', () => {
  const size = { width: 100, height: 40 }

  it('puts each node one column past its deepest parent and centers short columns', () => {
    const positions = layeredLayout(
      ['a', 'b', 'c', 'd'],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
      ],
      size
    )
    expect(positions.get('a')).toEqual({ x: 0, y: 30 })
    expect(positions.get('b')).toEqual({ x: 156, y: 0 })
    expect(positions.get('c')).toEqual({ x: 156, y: 60 })
    expect(positions.get('d')).toEqual({ x: 312, y: 30 })
  })

  it('breaks a cycle instead of recursing forever', () => {
    const positions = layeredLayout(
      ['a', 'b'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
      size
    )
    expect(positions.size).toBe(2)
  })
})
