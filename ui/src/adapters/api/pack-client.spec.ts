// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fetchPack } from './pack-client'

const PACK = {
  id: 'market-analysis',
  version: '1.0.0',
  title: 'Synthetic Multi-Asset Market Analysis',
  disclaimer: 'Synthetic market data for a software demonstration. Not investment advice.',
  questions: [
    {
      id: 'market-leaders',
      label: 'Market Leaders',
      tag: 'ANALYTICS',
      question: 'Which assets had the strongest returns?',
      sources: ['market_analysis_structured'],
      featured: true,
    },
  ],
}

describe('fetchPack', () => {
  beforeEach(() => {
    vi.stubEnv('API_URL', 'http://api.test:8000')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('reads the pack view from the API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(PACK)))

    const pack = await fetchPack()

    expect(fetch).toHaveBeenCalledWith('http://api.test:8000/v1/pack', expect.anything())
    expect(pack?.questions[0]).toMatchObject({
      id: 'market-leaders',
      tag: 'ANALYTICS',
      featured: true,
    })
  })

  test.each([
    ['the API is unreachable', () => Promise.reject(new TypeError('fetch failed'))],
    ['the API errors', () => Promise.resolve(new Response('nope', { status: 500 }))],
    ['the body has another shape', () => Promise.resolve(Response.json({ questions: 'none' }))],
  ])('returns null when %s', async (_case, response) => {
    vi.stubGlobal('fetch', vi.fn(response))

    await expect(fetchPack()).resolves.toBeNull()
  })
})
