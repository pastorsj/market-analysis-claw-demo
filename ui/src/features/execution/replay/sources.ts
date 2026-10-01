// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a run's events and receipts come from outside the live stream:
 *
 * - replay mode reads the data pack's recordings bundle (v2) through
 *   `/api/recordings/…`: `index.json` lists the sessions and
 *   `sessions/<id>.json` holds each turn with its events and receipts;
 * - live mode reads a job's export, `GET /v1/jobs/async/job/{id}/export`,
 *   which returns one turn in the same shape.
 *
 * Either way the turn lands in the execution store.
 */

import type { RecordedSession, RecordingsSource } from '@/shared/context'
import { useExecutionStore } from '../store'

/** One question and its run, as recorded or exported. */
export interface RecordedTurn {
  jobId: string
  question: string
  submittedAt: string
  completedAt: string | null
  status: string
  report: { markdown: string; citations: unknown[] } | null
  /** `execution.v2` events in stream order */
  events: unknown[]
  /** `ReceiptV2` receipts */
  receipts: unknown[]
  /** The job's data sources, when the recording has them */
  sourceIds?: string[]
  /** The CPU/GPU comparison of its market calls (`Benchmark`), when one ran */
  benchmark?: unknown
}

export interface RecordingIndex {
  schemaVersion: 2
  pack: { id: string; version: string }
  recordedAt: string
  sessions: {
    id: string
    title: string
    featured: boolean
    turns: { jobId: string; question: string }[]
  }[]
}

interface RecordingSession {
  schemaVersion: 2
  id: string
  title: string
  turns: RecordedTurn[]
}

const RERECORD =
  'These recordings are not in the v2 format; re-record them with `scripts/demo.sh record`.'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTurn = (value: unknown): value is RecordedTurn =>
  isRecord(value) &&
  typeof value.jobId === 'string' &&
  typeof value.question === 'string' &&
  Array.isArray(value.events) &&
  Array.isArray(value.receipts)

export const parseIndex = (value: unknown): RecordingIndex => {
  if (!isRecord(value) || value.schemaVersion !== 2 || !Array.isArray(value.sessions)) {
    throw new Error(RERECORD)
  }
  return value as unknown as RecordingIndex
}

export const parseSession = (value: unknown): RecordingSession => {
  if (!isRecord(value) || value.schemaVersion !== 2 || !Array.isArray(value.turns)) {
    throw new Error(RERECORD)
  }
  if (!value.turns.every(isTurn)) throw new Error('A recorded turn is malformed.')
  return value as unknown as RecordingSession
}

const parseTurn = (value: unknown): RecordedTurn => {
  if (!isTurn(value)) throw new Error('The job export is malformed.')
  return value
}

/** The chat's view of a recorded session. */
const toRecordedSession = (session: RecordingSession): RecordedSession => ({
  id: session.id,
  title: session.title,
  recordedAt: session.turns[0]?.completedAt ?? session.turns[0]?.submittedAt ?? '',
  turns: session.turns.map((turn) => ({
    question: turn.question,
    answer: turn.report?.markdown || null,
    jobId: turn.jobId,
    sourceIds: turn.sourceIds ?? [],
  })),
})

const getJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

/** Recorded sessions of the active data pack (replay mode). */
export const recordings: RecordingsSource = {
  list: async () => {
    const index = parseIndex(await getJson('/api/recordings/index.json'))
    return index.sessions.map(({ id, title }) => ({ id, title, recordedAt: index.recordedAt }))
  },
  load: async (sessionId) => {
    const session = parseSession(
      await getJson(`/api/recordings/sessions/${encodeURIComponent(sessionId)}.json`)
    )
    const { addRecord } = useExecutionStore.getState()
    for (const turn of session.turns) addRecord(turn)
    return toRecordedSession(session)
  },
}

/** Loads a live job's events and receipts from its export (live mode). */
export const loadJobExport = async (jobId: string): Promise<void> => {
  const turn = parseTurn(
    await getJson(`/api/v1/jobs/async/job/${encodeURIComponent(jobId)}/export`)
  )
  useExecutionStore.getState().addRecord(turn)
}
