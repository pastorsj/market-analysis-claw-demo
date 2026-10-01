// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The committed recordings (the retired market-analysis pack's, until the current packs are
 * recorded), as `scripts/demo.sh replay` serves them: every session opens with its answer and
 * its run, and nothing calls the API.
 * The expectations come from the bundle itself, so a re-recording needs no change here.
 */

import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { DATA_PACKS_DIR, PACK_REPLAY_URL } from '../playwright.config'

interface RecordedEvent {
  eventId: string
  eventKind: string
  invocationId?: string | null
}

const RECORDINGS = `${DATA_PACKS_DIR}/market-analysis/recordings`
const readJson = <T>(file: string): T => JSON.parse(readFileSync(`${RECORDINGS}/${file}`, 'utf8'))

const index = readJson<{ sessions: { id: string; title: string }[] }>('index.json')

/** Tool calls by invocation, as the run summary counts them. */
const toolCallCount = (events: RecordedEvent[]): number =>
  new Set(
    events
      .filter((event) => /^(tool|artifact)\./.test(event.eventKind))
      .map((event) => event.invocationId ?? event.eventId)
  ).size

test.use({ baseURL: PACK_REPLAY_URL })

test('the pack has recorded sessions', () => {
  expect(index.sessions.length).toBeGreaterThan(0)
})

for (const { id, title } of index.sessions) {
  test(`recorded session "${title}" replays its answer and run`, async ({ page }) => {
    const [turn] = readJson<{ turns: { events: RecordedEvent[] }[] }>(`sessions/${id}.json`).turns
    const apiCalls: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/')) apiCalls.push(request.url())
    })

    await page.goto('/research')
    await page
      .getByRole('button', { name: `Recorded session: ${title}; Completed` })
      .first()
      .click()
    await page.getByRole('button', { name: 'View execution for this response' }).click()

    const workspace = page.getByRole('region', { name: 'Execution workspace' })
    const steps = turn.events.length
    await expect(workspace.getByText(`Step ${steps} of ${steps}`)).toBeVisible()
    const summary = workspace.getByRole('region', { name: 'Hermes run summary' })
    await expect(
      summary.getByText(`${toolCallCount(turn.events)} tool call(s) ·`, { exact: false })
    ).toBeVisible()
    await expect(workspace.getByRole('list', { name: 'Execution graph legend' })).toBeVisible()
    await expect(workspace.getByRole('button', { name: 'Inspect Hermes Agent' })).toBeVisible()
    expect(apiCalls).toEqual([])
  })
}
