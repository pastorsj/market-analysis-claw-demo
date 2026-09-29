// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A stand-in for the demo API, just enough for the live-mode smoke test:
 * the pack, its data sources, and a job whose stream answers immediately.
 * Usage: FAKE_API_PORT=3990 node e2e/fake-api.mjs
 */

import { createServer } from 'node:http'

const PACK = {
  id: 'e2e',
  version: '1.0.0',
  title: 'E2E pack',
  disclaimer: 'Synthetic data for tests.',
  questions: [
    {
      id: 'market-leaders',
      label: 'Market Leaders',
      question: 'Which assets led the market?',
      sources: ['market_analysis_structured'],
      featured: true,
    },
  ],
}

const DATA_SOURCES = [
  { id: 'market_analysis_structured', name: 'Market data', description: 'Prices and volumes' },
  { id: 'market_news', name: 'Market news', description: 'Reviewed news', default_enabled: false },
]

const ANSWER =
  'Asset A led the market [1].\n\n**References:**\n' +
  '- [1] Market analytics result — market scan — evidence `ev-1` — invocation `call-1`'

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readJson = async (req) => {
  let body = ''
  for await (const chunk of req) body += chunk
  return JSON.parse(body)
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://fake-api')
  if (req.method === 'GET' && pathname === '/v1/pack') return json(res, PACK)
  if (req.method === 'GET' && pathname === '/v1/data_sources') return json(res, DATA_SOURCES)
  if (req.method === 'POST' && pathname === '/v1/jobs/async/submit') {
    const { job_id: jobId } = await readJson(req)
    return json(res, { job_id: jobId, status: 'submitted' })
  }
  if (req.method === 'GET' && pathname.endsWith('/stream')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('job.status', { status: 'running' }))
    res.write(
      sse('artifact.update', {
        data: { type: 'output', output_category: 'final_report', content: ANSWER },
      })
    )
    return res.end(sse('job.status', { status: 'success' }))
  }
  res.writeHead(404).end()
}).listen(Number(process.env.FAKE_API_PORT ?? 3990), '127.0.0.1')
