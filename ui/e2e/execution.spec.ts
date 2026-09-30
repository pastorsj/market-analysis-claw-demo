// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The execution view in replay mode, on the synthetic v2 bundle in
 * e2e/fixtures/packs/e2e/recordings (built from contracts/fixtures).
 */

import { expect, test, type Page } from '@playwright/test'
import { REPLAY_URL } from '../playwright.config'

test.use({ baseURL: REPLAY_URL })

const openSession = async (page: Page, title: string) => {
  await page.goto('/research')
  await page
    .getByRole('button', { name: `Session: ${title}` })
    .first()
    .click()
}

test('a recorded session replays its run as a graph and opens an explorer', async ({ page }) => {
  const apiCalls: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/')) apiCalls.push(request.url())
  })

  await openSession(page, 'Unusual moves and filings')
  await expect(page.getByText('Asset Delta showed the most unusual combination')).toBeVisible()
  await page.getByRole('button', { name: 'View execution for this response' }).click()

  const workspace = page.getByRole('region', { name: 'Execution workspace' })
  await expect(workspace.getByText(/completed · 2 tool calls · 2 model calls/)).toBeVisible()
  const graph = workspace.getByRole('figure', { name: 'Execution graph' })
  await expect(graph.getByRole('group', { name: 'Hermes agent, completed' })).toBeVisible()
  await expect(graph.getByText('OpenShell sandbox')).toBeVisible()
  await expect(graph.getByText('gpt-6-sol · capable')).toBeVisible()
  await expect(graph.locator('.react-flow__edge')).toHaveCount(9)

  // The retrieval tool carries the LangChain logo, and it loads
  const retrieval = graph.getByRole('group', { name: 'Unstructured Retrieval, completed' })
  const langchain = retrieval.getByRole('img', { name: 'LangChain' })
  await expect(langchain).toHaveAttribute('src', '/ecosystem-logos/langchain.svg')
  await expect
    .poll(() => langchain.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0)

  await graph.getByRole('group', { name: 'Market Anomaly Scan, completed' }).click()
  const explorer = workspace.getByRole('region', { name: 'Market Anomaly Scan explorer' })
  await expect(explorer.getByRole('img', { name: /Anomaly score by observation/ })).toBeVisible()
  await expect(explorer.getByText('GPU · cuml.accel 26.6.0')).toBeVisible()

  // Replay: step back to the start, where no tool has run yet
  await workspace.getByRole('slider', { name: 'Replay step' }).press('Home')
  await expect(workspace.getByText('Step 0 of 10')).toBeVisible()
  await expect(graph.getByRole('group', { name: 'Market Anomaly Scan, idle' })).toBeVisible()

  expect(apiCalls).toEqual([])
})

test('a cited source opens its evidence in the execution view', async ({ page }) => {
  await openSession(page, 'Dividends and news likelihood')
  const sources = page.getByRole('region', { name: 'Sources' }).first()
  await sources.locator('summary').click()
  await sources.getByRole('button', { name: 'Open this run in the execution view' }).click()

  const explorer = page.getByRole('region', { name: 'Auto Ontology explorer' })
  await expect(explorer.getByRole('figure', { name: 'Grounding' })).toBeVisible()
  await expect(explorer.getByText('main.corporate_actions.cash_amount_usd')).toBeVisible()
  await expect(explorer.getByText(/WITH price_history AS/)).toBeVisible()
})
