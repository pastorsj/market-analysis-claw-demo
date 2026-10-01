// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import { LIVE_URL, REPLAY_URL } from '../playwright.config'

/** The chat store's saved state: a live session whose job was running when the page closed. */
const SAVED_LIVE_SESSION = JSON.stringify({
  state: {
    currentUserId: 'local',
    currentConversation: null,
    conversations: [
      {
        id: 's_saved',
        userId: 'local',
        title: 'Which assets led?',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        messages: [
          {
            id: 'answer',
            role: 'assistant',
            content: '',
            timestamp: '2026-09-01T00:00:00.000Z',
            messageType: 'agent_response',
            deepResearchJobId: 'job-1',
            deepResearchJobStatus: 'running',
            isDeepResearchActive: true,
          },
        ],
      },
    ],
  },
  version: 0,
})

test.describe('live mode', () => {
  test.use({ baseURL: LIVE_URL })

  test('a featured question is asked and answered with its cited evidence', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle('Enterprise Research')

    await page.getByRole('link', { name: /Market Leaders/ }).click()
    const composer = page.getByRole('textbox', { name: 'Chat message input' })
    await expect(composer).toHaveValue('Which assets led the market?')

    await page.getByRole('button', { name: 'Send message' }).click()

    await expect(page.getByText('Asset A led the market')).toBeVisible()
    const evidence = page.getByRole('region', { name: 'Sources' }).locator('summary')
    await expect(evidence).toContainText('Market analytics result — market scan')
    await evidence.click()
    await expect(evidence).toContainText('Close')
    await expect(composer).toBeEnabled()
  })

  test('voice input records a question and puts its transcript in the composer', async ({
    page,
  }) => {
    await page.goto('/research')
    const composer = page.getByRole('textbox', { name: 'Chat message input' })

    await page.getByRole('button', { name: 'Start voice input' }).click()
    await expect(page.getByRole('button', { name: 'Stop voice recording' })).toBeVisible()
    await page.waitForTimeout(800)
    await page.getByRole('button', { name: 'Stop voice recording' }).click()

    // The fake API transcribes any valid WAV recording to the same question
    await expect(composer).toHaveValue('Which assets led the market?')
    await expect(page.getByRole('button', { name: 'Start voice input' })).toBeEnabled()
  })

  test('the landing page fits a 1280x800, 1440x900 or 1920x1080 screen without scrolling, and its logos load', async ({
    page,
  }) => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport)
      for (const colorScheme of ['light', 'dark'] as const) {
        const where = `${viewport.width}x${viewport.height} ${colorScheme}`
        await page.emulateMedia({ colorScheme })
        await page.goto('/')
        const featured = page.getByRole('region', { name: 'Featured questions' })
        await expect(featured.getByRole('link')).toHaveCount(6)

        const logos = page.locator('main [data-brand] img')
        await expect(logos).toHaveCount(14)
        await expect
          .poll(() =>
            logos.evaluateAll((images: HTMLImageElement[]) => images.map((i) => i.complete))
          )
          .not.toContain(false)
        const broken = await logos.evaluateAll((images: HTMLImageElement[]) =>
          images.filter((i) => i.naturalWidth === 0).map((i) => i.src)
        )
        expect(broken, `${where}: logos that did not load`).toEqual([])
        const langchain = page.locator('main [data-brand="LangChain"] img')
        await expect(langchain).toHaveAttribute('src', '/ecosystem-logos/langchain.svg')
        expect(await langchain.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0)

        const size = await page.evaluate(() => ({
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight: window.innerHeight,
        }))
        expect(size.scrollHeight, `${where}: page height`).toBeLessThanOrEqual(size.innerHeight)
      }
    }
  })
})

test.describe('replay mode', () => {
  test.use({ baseURL: REPLAY_URL })

  test('the research view never calls the API and its composer is read only', async ({ page }) => {
    const apiCalls: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/')) apiCalls.push(request.url())
    })
    await page.addInitScript((saved) => {
      if (!localStorage.getItem('aiq-chat-store')) localStorage.setItem('aiq-chat-store', saved)
    }, SAVED_LIVE_SESSION)

    await page.goto('/')
    await page.getByRole('link', { name: /Enter market analysis/ }).click()

    await expect(page.getByText('What do you want to know?')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Chat message input' })).toBeDisabled()
    await expect(page.getByText('Recorded test session · read only')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add data sources' })).toBeDisabled()
    // The saved live session stays out of the replay's lists
    await page.getByRole('tab', { name: 'My sessions' }).click()
    await expect(page.getByText('Replay mode shows the recorded sessions only.')).toBeVisible()
    expect(apiCalls).toEqual([])
    const saved = await page.evaluate(() => localStorage.getItem('aiq-chat-store'))
    expect(JSON.parse(saved!).state.conversations[0].messages[0].deepResearchJobStatus).toBe(
      'running'
    )
  })

  test('serves the health check and the data pack recordings', async ({ request }) => {
    expect(await (await request.get('/api/health')).json()).toEqual({
      status: 'ok',
      mode: 'replay',
    })
    expect(await (await request.get('/api/recordings/index.json')).json()).toMatchObject({
      schemaVersion: 2,
      pack: { id: 'e2e' },
    })
  })
})
