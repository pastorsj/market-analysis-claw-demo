// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Smoke tests against the production build (`npm run build` first).
 *
 * Three UI servers run from the same build: live mode against a fake API,
 * replay mode on the fixture data pack, and replay mode on the committed
 * recordings (the retired market-analysis pack's, until the current packs are
 * recorded). No screenshots or visual baselines.
 */

import { defineConfig, devices } from '@playwright/test'

const FAKE_API = 'http://127.0.0.1:3990'
export const LIVE_URL = 'http://127.0.0.1:3991'
export const REPLAY_URL = 'http://127.0.0.1:3992'
export const PACK_REPLAY_URL = 'http://127.0.0.1:3993'
export const DATA_PACKS_DIR = `${process.cwd()}/../data/packs`

const uiServer = (url: string, env: Record<string, string>) => ({
  command: 'node .next/standalone/server.js',
  url: `${url}/api/health`,
  env: { HOSTNAME: '127.0.0.1', PORT: new URL(url).port, ...env },
  reuseExistingServer: !process.env.CI,
})

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'on-first-retry',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'smoke',
      use: {
        ...devices['Desktop Chrome'],
        // A fake microphone (a tone), granted without a prompt, for the voice input test
        permissions: ['microphone'],
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
  ],
  webServer: [
    {
      command: 'node e2e/fake-api.mjs',
      url: `${FAKE_API}/v1/pack`,
      env: { FAKE_API_PORT: new URL(FAKE_API).port },
      reuseExistingServer: !process.env.CI,
    },
    uiServer(LIVE_URL, { UI_MODE: 'live', API_URL: FAKE_API, SPEECH_INPUT_ENABLED: 'true' }),
    uiServer(REPLAY_URL, {
      UI_MODE: 'replay',
      PACKS_DIR: `${process.cwd()}/e2e/fixtures/packs`,
      DATA_PACK: 'e2e',
    }),
    uiServer(PACK_REPLAY_URL, {
      UI_MODE: 'replay',
      PACKS_DIR: DATA_PACKS_DIR,
      DATA_PACK: 'market-analysis',
    }),
  ],
})
