// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Each pack's committed recordings, as `scripts/demo.sh replay` serves them: every session opens
 * with an answer per turn and the last turn's run, and nothing calls the API.
 * The expectations come from the bundles themselves, so a re-recording needs no change here.
 */

import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { DATA_PACKS_DIR, RECORDED_PACKS } from '../playwright.config'

interface RecordedEvent {
  eventId: string
  eventKind: string
  invocationId?: string | null
}

/** Tool calls by invocation, as the run summary counts them. */
const toolCallCount = (events: RecordedEvent[]): number =>
  new Set(
    events
      .filter((event) => /^(tool|artifact)\./.test(event.eventKind))
      .map((event) => event.invocationId ?? event.eventId)
  ).size

for (const [pack, baseURL] of Object.entries(RECORDED_PACKS)) {
  const readJson = <T>(file: string): T =>
    JSON.parse(readFileSync(`${DATA_PACKS_DIR}/${pack}/recordings/${file}`, 'utf8'))
  const index = readJson<{ pack: { id: string }; sessions: { id: string; title: string }[] }>(
    'index.json'
  )

  test.describe(`${pack} recordings`, () => {
    test.use({ baseURL })

    test('the pack has recorded sessions', () => {
      expect(index.pack.id).toBe(pack)
      expect(index.sessions.length).toBeGreaterThan(0)
    })

    for (const { id, title } of index.sessions) {
      test(`recorded session "${title}" replays its answer and run`, async ({ page }) => {
        const { turns } = readJson<{ turns: { events: RecordedEvent[] }[] }>(`sessions/${id}.json`)
        const turn = turns[turns.length - 1]
        const apiCalls: string[] = []
        page.on('request', (request) => {
          if (new URL(request.url()).pathname.startsWith('/api/v1/')) apiCalls.push(request.url())
        })

        await page.goto('/research')
        await page
          .getByRole('button', { name: `Recorded session: ${title}; Completed` })
          .first()
          .click()
        const viewRuns = page.getByRole('button', { name: 'View execution for this response' })
        await expect(viewRuns).toHaveCount(turns.length)
        await viewRuns.last().click()

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
  })
}
