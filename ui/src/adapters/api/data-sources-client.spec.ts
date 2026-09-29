// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test, vi } from 'vitest'
import { fetchDataSources } from './data-sources-client'

const SOURCES = [{ id: 'market_news', name: 'Market news' }]

describe('fetchDataSources', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test.each([
    ['a wrapped list', { data_sources: SOURCES }],
    ['a bare list', SOURCES],
  ])('accepts %s', async (_shape, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)))

    await expect(fetchDataSources()).resolves.toEqual(SOURCES)
    expect(fetch).toHaveBeenCalledWith('/api/v1/data_sources', { signal: undefined })
  })

  test('throws the proxy error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { message: 'The API is unavailable' } }, { status: 502 })
        )
    )

    await expect(fetchDataSources()).rejects.toThrow('The API is unavailable')
  })
})
