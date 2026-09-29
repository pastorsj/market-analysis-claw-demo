// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fetchDataSources } from '@/adapters/api'
import { useLayoutStore } from './store'

vi.mock('@/adapters/api', () => ({ fetchDataSources: vi.fn() }))

const initialState = useLayoutStore.getState()

describe('useLayoutStore', () => {
  beforeEach(() => {
    useLayoutStore.setState(initialState, true)
  })

  test('opens the data sources panel by default', () => {
    expect(useLayoutStore.getState().rightPanel).toBe('data-sources')
  })

  describe('sessions sidebar collapse model', () => {
    test('opening a research/data-sources panel auto-collapses the sidebar', () => {
      useLayoutStore.getState().closeRightPanel()
      useLayoutStore.getState().openRightPanel('research')

      expect(useLayoutStore.getState()).toMatchObject({
        rightPanel: 'research',
        sessionsCollapsed: true,
        sessionsAutoCollapsed: true,
      })
    })

    test('closing after an auto-collapse restores the sidebar', () => {
      useLayoutStore.getState().openRightPanel('research')
      useLayoutStore.getState().closeRightPanel()

      expect(useLayoutStore.getState()).toMatchObject({
        rightPanel: null,
        sessionsCollapsed: false,
      })
    })

    test('does not auto-restore a sidebar the user collapsed manually', () => {
      useLayoutStore.getState().setSessionsCollapsed(true)
      useLayoutStore.getState().openRightPanel('research')
      useLayoutStore.getState().closeRightPanel()

      expect(useLayoutStore.getState().sessionsCollapsed).toBe(true)
    })
  })

  test('opens and closes the execution workspace with an optional focus', () => {
    useLayoutStore.getState().openExecution('job-1', { referenceId: 'ev-1' })
    expect(useLayoutStore.getState().execution).toEqual({
      jobId: 'job-1',
      focus: { referenceId: 'ev-1' },
    })

    useLayoutStore.getState().openExecution('job-2')
    expect(useLayoutStore.getState().execution).toEqual({ jobId: 'job-2', focus: null })

    useLayoutStore.getState().closeExecution()
    expect(useLayoutStore.getState().execution).toBeNull()
  })

  test('toggles a data source on and off', () => {
    useLayoutStore.getState().toggleDataSource('market_news')
    expect(useLayoutStore.getState().enabledDataSourceIds).toEqual(['market_news'])

    useLayoutStore.getState().toggleDataSource('market_news')
    expect(useLayoutStore.getState().enabledDataSourceIds).toEqual([])
  })

  describe('fetchDataSources', () => {
    test('stores the sources and enables those enabled by default', async () => {
      vi.mocked(fetchDataSources).mockResolvedValue([
        { id: 'market_analysis_structured', name: 'Market data' },
        { id: 'market_news', name: 'News', default_enabled: false },
      ])

      await useLayoutStore.getState().fetchDataSources()

      expect(useLayoutStore.getState()).toMatchObject({
        availableDataSources: [{ id: 'market_analysis_structured' }, { id: 'market_news' }],
        enabledDataSourceIds: ['market_analysis_structured'],
        dataSourcesLoading: false,
        dataSourcesError: null,
      })
    })

    test('records the error message on failure', async () => {
      vi.mocked(fetchDataSources).mockRejectedValue(new Error('API down'))

      await useLayoutStore.getState().fetchDataSources()

      expect(useLayoutStore.getState()).toMatchObject({
        dataSourcesLoading: false,
        dataSourcesError: 'API down',
      })
    })
  })
})
