// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Timeline rows for one run, positioned in milliseconds from its start: the
 * run itself, each tool call as a span, each model call and any other event
 * as an instant. Heartbeats are left out.
 */

import type { ExecutionEventV2 } from '../contract'
import { elapsedMs, formatCount } from '../format'
import type { CallState, RunProjection } from '../projection'

export type RowKind = 'run' | 'tool' | 'model' | 'event'

export interface TimelineRow {
  id: string
  kind: RowKind
  label: string
  detail: string | null
  state: CallState | 'info'
  startMs: number
  /** null for an instant */
  durationMs: number | null
  badges: string[]
  /** The tool call a tool row stands for */
  invocationId: string | null
}

export interface Timeline {
  rows: TimelineRow[]
  totalMs: number
}

const HANDLED = /^(run|tool|artifact)\.|^llm\.call$|\.heartbeat$/

export const buildTimeline = (
  events: readonly ExecutionEventV2[],
  run: RunProjection
): Timeline => {
  if (!run.startedAt || events.length === 0) return { rows: [], totalMs: 0 }
  const start = run.startedAt
  const end = run.endedAt ?? events[events.length - 1].occurredAt
  const offset = (at: string) => Math.max(0, elapsedMs(start, at))
  const totalMs = offset(end)

  const rows: TimelineRow[] = [
    {
      id: 'run',
      kind: 'run',
      label: 'Hermes run',
      detail: run.status,
      state:
        run.status === 'running' ? 'running' : run.status === 'completed' ? 'completed' : 'failed',
      startMs: 0,
      durationMs: totalMs,
      badges: [],
      invocationId: null,
    },
  ]

  for (const call of run.toolCalls) {
    rows.push({
      id: call.invocationId,
      kind: 'tool',
      label: call.label,
      detail: call.tool ? null : call.name,
      state: call.state,
      startMs: offset(call.startedAt),
      durationMs: offset(call.endedAt ?? end) - offset(call.startedAt),
      badges: call.receiptIds.length ? [`${call.receiptIds.length} evidence`] : [],
      invocationId: call.invocationId,
    })
  }

  for (const call of run.modelCalls) {
    const tokens =
      call.inputTokens !== null && call.outputTokens !== null
        ? `${formatCount(call.inputTokens)} in · ${formatCount(call.outputTokens)} out`
        : null
    rows.push({
      id: call.invocationId,
      kind: 'model',
      label: 'Model call',
      detail: tokens,
      state: 'completed',
      startMs: offset(call.occurredAt),
      durationMs: null,
      badges: [],
      invocationId: null,
    })
  }

  for (const event of events) {
    if (HANDLED.test(event.eventKind)) continue
    rows.push({
      id: event.eventId,
      kind: 'event',
      label: event.display.label,
      detail: event.display.summary,
      state: 'info',
      startMs: offset(event.occurredAt),
      durationMs: null,
      badges: [],
      invocationId: null,
    })
  }

  const [runRow, ...rest] = rows
  return { rows: [runRow, ...rest.sort((a, b) => a.startMs - b.startMs)], totalMs }
}
