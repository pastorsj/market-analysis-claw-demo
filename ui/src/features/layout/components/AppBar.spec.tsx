// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useLayoutStore } from '../store'
import { AppBar } from './AppBar'

const initialLayout = useLayoutStore.getState()

describe('AppBar', () => {
  beforeEach(() => {
    useLayoutStore.setState(initialLayout, true)
  })

  test('shows the session title and starts a new session from the logo', async () => {
    const onNewSession = vi.fn()
    render(<AppBar sessionTitle="Market leaders" onNewSession={onNewSession} />)

    expect(screen.getByText('Market leaders')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Create new session' }))
    expect(onNewSession).toHaveBeenCalledOnce()
  })

  test('does not start a new session while disabled', () => {
    render(<AppBar onNewSession={vi.fn()} isNewSessionDisabled />)

    expect(screen.getByRole('button', { name: 'Create new session' })).toBeDisabled()
  })

  test('toggles the data sources panel', async () => {
    render(<AppBar />)
    const button = screen.getByRole('button', { name: 'Add data sources' })

    await userEvent.click(button)
    expect(useLayoutStore.getState().rightPanel).toBeNull()
    await userEvent.click(button)
    expect(useLayoutStore.getState().rightPanel).toBe('data-sources')
  })

  test('hides the data sources action when asked', () => {
    render(<AppBar showDataSources={false} />)

    expect(screen.queryByRole('button', { name: 'Add data sources' })).not.toBeInTheDocument()
  })

  test('links to Phoenix only when it is configured', () => {
    const { unmount } = render(<AppBar />)
    expect(screen.queryByTestId('phoenix-observability-link')).not.toBeInTheDocument()
    unmount()

    render(<AppBar />, { config: { phoenixUrl: 'http://127.0.0.1:6006' } })
    expect(screen.getByTestId('phoenix-observability-link')).toHaveAttribute(
      'href',
      'http://127.0.0.1:6006'
    )
  })

  test('switches between light and dark themes', async () => {
    useLayoutStore.setState({ theme: 'light' })
    render(<AppBar />)

    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }))
    expect(useLayoutStore.getState().theme).toBe('dark')
  })
})
