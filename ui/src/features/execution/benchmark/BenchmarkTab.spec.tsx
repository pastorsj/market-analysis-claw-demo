// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import { buildActionTimeline } from '../activity/activity-model'
import type { Benchmark } from '../contract'
import { useExecutionStore, type ExecutionRecord } from '../store'
import { fixtureEvents, readRecording } from '../test-utils/fixtures'
import { BenchmarkTab } from './BenchmarkTab'
import { benchmarkEligibility, stageClaim } from './benchmark-model'

const [turn] = (readRecording('sessions/unusual-moves.json') as { turns: ExecutionRecord[] }).turns
const benchmark = turn.benchmark as Benchmark
const JOB = turn.jobId
const timeline = buildActionTimeline(fixtureEvents)

/** The tab as the panel renders it, reading the comparison from the store like the panel does. */
const LiveTab = () => {
  const stored = useExecutionStore((state) => state.runs[JOB]?.benchmark ?? null)
  return (
    <BenchmarkTab
      jobId={JOB}
      events={fixtureEvents}
      timeline={timeline}
      benchmark={stored}
      recorded={false}
    />
  )
}

describe('BenchmarkTab', () => {
  beforeEach(() => useExecutionStore.setState({ runs: {}, dropped: 0 }))
  afterEach(() => vi.restoreAllMocks())

  test('runs the comparison of a finished live run on request and keeps it', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) =>
        init?.method === 'POST'
          ? Response.json(benchmark)
          : Response.json({ detail: 'none yet' }, { status: 404 })
      )
    render(<LiveTab />)

    const start = await screen.findByRole('button', { name: 'Run comparison' })
    expect(screen.getByText(/1 observed market operation can be replayed/)).toBeVisible()
    await userEvent.click(start)

    expect(await screen.findByText('Observed benchmark')).toBeVisible()
    expect(screen.getByTestId('benchmark-tool-time-ratio')).toHaveTextContent('1.86× faster')
    expect(screen.getByText('cuml.accel')).toBeVisible()
    expect(screen.getByText('scikit-learn')).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/jobs/async/job/${JOB}/benchmark`, {
      method: 'POST',
      cache: 'no-store',
    })
    expect(useExecutionStore.getState().runs[JOB].benchmark).toEqual(benchmark)
  })

  test('restores a comparison the API already holds', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(benchmark))
    render(<LiveTab />)

    expect(await screen.findByText('Observed benchmark')).toBeVisible()
  })

  test('says why when there is no GPU service to compare on', async () => {
    const reason = 'This analytics service runs on the CPU only.'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      init?.method === 'POST'
        ? Response.json({ ...benchmark, status: 'unavailable', reason, stages: [] })
        : new Response(null, { status: 404 })
    )
    render(<LiveTab />)

    await userEvent.click(await screen.findByRole('button', { name: 'Run comparison' }))

    expect(await screen.findByText('Benchmark service unavailable')).toBeVisible()
    expect(screen.getByText(reason)).toBeVisible()
    expect(useExecutionStore.getState().runs[JOB]?.benchmark ?? null).toBeNull()
  })

  test('a recording without a comparison says so, and never calls the API', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    render(
      <BenchmarkTab
        jobId={JOB}
        events={fixtureEvents}
        timeline={timeline}
        benchmark={null}
        recorded
      />
    )

    expect(screen.getByText('No recorded benchmark')).toBeVisible()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('a run without market analytics has nothing to compare', () => {
    const retrievalOnly = fixtureEvents.filter((event) => event.toolName !== 'market_anomaly_scan')
    const noTools = fixtureEvents.filter((event) => !event.toolName)
    const { rerender } = render(
      <BenchmarkTab
        jobId={JOB}
        events={retrievalOnly}
        timeline={timeline}
        benchmark={null}
        recorded
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Retrieval comparison is unavailable')

    rerender(
      <BenchmarkTab jobId={JOB} events={noTools} timeline={timeline} benchmark={null} recorded />
    )
    expect(screen.getByText('No GPU analytics to compare')).toBeVisible()
  })
})

describe('benchmark model', () => {
  test('eligibility comes from the run’s market and retrieval results', () => {
    expect(benchmarkEligibility(fixtureEvents)).toEqual({
      market: true,
      retrieval: true,
      completed: true,
      marketCallCount: 1,
    })
    expect(benchmarkEligibility(fixtureEvents.slice(0, 4)).completed).toBe(false)
  })

  test('a stage claims a speedup only when the API qualified it', () => {
    const [stage] = benchmark.stages
    expect(stageClaim(stage)).toMatchObject({ label: 'Qualified speedup', value: '1.9×' })
    expect(
      stageClaim({ ...stage, qualified: false, speedup: null, speedupRange: null })
    ).toMatchObject({ label: 'Unqualified sample', value: 'No speedup claim' })
    expect(stageClaim({ ...stage, outcome: 'mismatch', reason: 'differs at payload.x' })).toEqual({
      label: 'Comparison outcome',
      value: 'Output mismatch',
      detail: 'differs at payload.x',
    })
  })
})
