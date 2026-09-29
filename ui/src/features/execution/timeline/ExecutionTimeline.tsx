// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ReactNode } from 'react'
import { Badge, Button, Text } from '@/adapters/ui'
import { formatDuration } from '../format'
import type { Timeline, TimelineRow } from './timeline-model'
import styles from './timeline.module.css'

interface ExecutionTimelineProps {
  timeline: Timeline
  /** Opens the explorer of a tool call */
  onSelectCall?: (invocationId: string) => void
}

const percent = (part: number, whole: number) => `${whole > 0 ? (100 * part) / whole : 0}%`

const RowLabel = ({
  row,
  onSelectCall,
}: {
  row: TimelineRow
  onSelectCall?: (id: string) => void
}) =>
  row.invocationId && onSelectCall ? (
    <Button kind="tertiary" size="tiny" onClick={() => onSelectCall(row.invocationId!)}>
      {row.label}
    </Button>
  ) : (
    <Text kind="label/semibold/sm">{row.label}</Text>
  )

export const ExecutionTimeline = ({
  timeline,
  onSelectCall,
}: ExecutionTimelineProps): ReactNode => {
  if (timeline.rows.length === 0) {
    return <Text kind="body/regular/sm">No activity yet.</Text>
  }
  return (
    <ol className={styles.timeline} aria-label="Execution timeline">
      {timeline.rows.map((row) => (
        <li key={row.id} className={styles.row} data-kind={row.kind} data-state={row.state}>
          <div className={styles.label}>
            <RowLabel row={row} onSelectCall={onSelectCall} />
            {row.detail && <span className={styles.detail}>{row.detail}</span>}
            {row.badges.map((badge) => (
              <Badge key={badge} kind="outline" color={row.kind === 'model' ? 'green' : 'gray'}>
                {badge}
              </Badge>
            ))}
          </div>
          <div className={styles.track} aria-hidden="true">
            {row.durationMs === null ? (
              <span
                className={styles.instant}
                style={{ left: percent(row.startMs, timeline.totalMs) }}
              />
            ) : (
              <span
                className={styles.span}
                style={{
                  left: percent(row.startMs, timeline.totalMs),
                  width: percent(row.durationMs, timeline.totalMs),
                }}
              />
            )}
          </div>
          <span className={styles.time}>
            {row.durationMs === null
              ? `+${formatDuration(row.startMs)}`
              : formatDuration(row.durationMs)}
          </span>
        </li>
      ))}
    </ol>
  )
}
