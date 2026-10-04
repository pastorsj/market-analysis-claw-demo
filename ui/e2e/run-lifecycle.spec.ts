// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A run's lifecycle in live mode, against the fake API: a question started from a landing card or
 * the composer, then followed through a slow admission, a reload, Back and Forward, and a double
 * click on Run. The run must reach its answer, and no failure or unavailable banner may render at
 * any moment, not even for a frame.
 *
 * Each test plans its job on the fake API before the submission reaches it (`POST /e2e/jobs/<id>`):
 * how long its admission takes, during which the API does not know it (404), and how long it runs.
 */

import { expect, test, type Page } from '@playwright/test'
import { FAKE_API, LIVE_URL } from '../playwright.config'

test.use({ baseURL: LIVE_URL })

interface JobPlan {
  /** How long the submission waits before the job exists */
  admitAfterMs?: number
  /** How long the job runs once admitted */
  runForMs?: number
}

/** Plans every job the page submits; returns the job ids, in submission order. */
const planJobs = async (page: Page, plan: JobPlan): Promise<string[]> => {
  const jobIds: string[] = []
  await page.route('**/api/v1/jobs/async/submit', async (route) => {
    const { job_id: jobId } = route.request().postDataJSON() as { job_id: string }
    jobIds.push(jobId)
    const planned = await fetch(`${FAKE_API}/e2e/jobs/${jobId}`, {
      method: 'POST',
      body: JSON.stringify(plan),
    })
    expect(planned.ok).toBe(true)
    await route.continue()
  })
  return jobIds
}

/** What the run reported that it should not have: the text of any failure or unavailable banner. */
const ALERTS =
  /Run unavailable|no longer available|Run failed|Run stopped|Lost connection|Deep Research Failed/g

/** Records every alert that renders, across reloads, in the tab's session storage. */
const watchAlerts = async (page: Page) => {
  await page.addInitScript((source) => {
    const pattern = new RegExp(source, 'g')
    const record = () => {
      const found = document.body?.innerText.match(pattern) ?? []
      if (!found.length) return
      const seen = new Set(JSON.parse(sessionStorage.getItem('e2e-alerts') ?? '[]') as string[])
      for (const text of found) seen.add(text)
      sessionStorage.setItem('e2e-alerts', JSON.stringify([...seen]))
    }
    new MutationObserver(record).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    })
  }, ALERTS.source)
}

const seenAlerts = (page: Page): Promise<string[]> =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('e2e-alerts') ?? '[]') as string[])

/** The job requests the page made, as `METHOD path -> status`. */
const recordJobRequests = (page: Page): string[] => {
  const log: string[] = []
  page.on('response', (response) => {
    const { pathname } = new URL(response.url())
    if (pathname.startsWith('/api/v1/jobs/')) {
      log.push(`${response.request().method()} ${pathname} -> ${response.status()}`)
    }
  })
  return log
}

/** Opens the landing page and clicks the Market Leaders card; the composer holds its question. */
const askFeaturedQuestion = async (page: Page) => {
  await expect(async () => {
    await page.goto('/')
    await expect(
      page.getByRole('region', { name: 'Featured questions' }).getByRole('link')
    ).toHaveCount(6, { timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await page.getByRole('link', { name: /Market Leaders/ }).click()
  await expect(page.getByRole('textbox', { name: 'Chat message input' })).toHaveValue(
    'Which assets led the market?'
  )
}

const answer = (page: Page) => page.getByText('Asset A led the market')
const runButton = (page: Page) => page.getByRole('button', { name: 'Send message' })
const sessionInUrl = /\/research\?session=s_[A-Za-z0-9_]+$/

test.beforeEach(async ({ page }) => {
  await watchAlerts(page)
})

test('a landing card run whose admission is slow never shows the run as unavailable', async ({
  page,
}) => {
  const jobIds = await planJobs(page, { admitAfterMs: 400, runForMs: 1_500 })
  const requests = recordJobRequests(page)
  await askFeaturedQuestion(page)

  await runButton(page).click()

  await expect(page.getByText('Run started')).toBeVisible()
  await expect(answer(page)).toBeVisible({ timeout: 10_000 })
  expect(await seenAlerts(page)).toEqual([])
  // The run is followed once admitted: its status is never asked for before
  expect(requests).not.toContain(`GET /api/v1/jobs/async/job/${jobIds[0]} -> 404`)
  // The question was consumed: a reload of this URL reopens the session
  await expect(page).toHaveURL(sessionInUrl)
})

test('a reload while the submission is still in flight follows the run once it is admitted', async ({
  page,
}) => {
  const jobIds = await planJobs(page, { admitAfterMs: 2_000, runForMs: 1_000 })
  const requests = recordJobRequests(page)
  await askFeaturedQuestion(page)
  await runButton(page).click()
  await expect(page).toHaveURL(sessionInUrl)

  await page.reload()

  await expect(answer(page)).toBeVisible({ timeout: 15_000 })
  expect(await seenAlerts(page)).toEqual([])
  // The API did not know the job yet after the reload (404), then did (200)
  const status = `GET /api/v1/jobs/async/job/${jobIds[0]}`
  expect(requests).toContain(`${status} -> 404`)
  expect(requests).toContain(`${status} -> 200`)
  expect(requests.indexOf(`${status} -> 404`)).toBeLessThan(requests.indexOf(`${status} -> 200`))
})

test('a reload while the run is going follows it to its answer', async ({ page }) => {
  await planJobs(page, { runForMs: 3_000 })
  await askFeaturedQuestion(page)
  await runButton(page).click()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
  await expect(page).toHaveURL(sessionInUrl)
  const url = page.url()
  await page.waitForTimeout(500)

  await page.reload()

  await expect(page).toHaveURL(url)
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
  await expect(answer(page)).toBeVisible({ timeout: 10_000 })
  expect(await seenAlerts(page)).toEqual([])
  await expect(page.getByRole('textbox', { name: 'Chat message input' })).toHaveValue('')
})

test('a run started from a typed question survives a reload', async ({ page }) => {
  await planJobs(page, { runForMs: 3_000 })
  await page.goto('/research')
  const composer = page.getByRole('textbox', { name: 'Chat message input' })
  await composer.fill('Which issuers were the most volatile?')
  await runButton(page).click()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
  await expect(page).toHaveURL(sessionInUrl)
  await page.waitForTimeout(500)

  await page.reload()

  await expect(answer(page)).toBeVisible({ timeout: 10_000 })
  expect(await seenAlerts(page)).toEqual([])
})

test('Back and Forward during a run come back to it, still followed', async ({ page }) => {
  await planJobs(page, { runForMs: 3_000 })
  await askFeaturedQuestion(page)
  await runButton(page).click()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
  await expect(page).toHaveURL(sessionInUrl)
  const url = page.url()

  await page.goBack()
  await expect(page.getByRole('region', { name: 'Featured questions' })).toBeVisible()
  await page.goForward()

  await expect(page).toHaveURL(url)
  await expect(answer(page)).toBeVisible({ timeout: 10_000 })
  expect(await seenAlerts(page)).toEqual([])
  // Not a new draft of the same question
  await expect(page.getByRole('textbox', { name: 'Chat message input' })).toHaveValue('')
})

test('a finished landing card run is still there after a reload, with no question to ask again', async ({
  page,
}) => {
  await askFeaturedQuestion(page)
  await runButton(page).click()
  await expect(answer(page)).toBeVisible()
  await expect(page).toHaveURL(sessionInUrl)

  await page.reload()

  await expect(answer(page)).toBeVisible()
  await expect(page).toHaveURL(sessionInUrl)
  await expect(page.getByRole('textbox', { name: 'Chat message input' })).toHaveValue('')
  expect(await seenAlerts(page)).toEqual([])
})

test('a double click on Run starts one run and does not stop it', async ({ page }) => {
  const jobIds = await planJobs(page, { runForMs: 1_500 })
  const requests = recordJobRequests(page)
  await askFeaturedQuestion(page)

  // Two clicks 40 ms apart, the second after the submission was answered (as on a deployment)
  const box = (await runButton(page).boundingBox())!
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.click(x, y)
  await expect.poll(() => requests.some((line) => line.startsWith('GET'))).toBe(true)
  await page.mouse.click(x, y)

  await expect(answer(page)).toBeVisible({ timeout: 10_000 })
  expect(jobIds).toHaveLength(1)
  expect(requests.filter((line) => line.includes('/cancel'))).toEqual([])
  expect(await seenAlerts(page)).toEqual([])
})
