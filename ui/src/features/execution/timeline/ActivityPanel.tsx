// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** The Agent Activity side panel: the current job's timeline as it streams in. */

'use client'

import { useMemo, type ReactNode } from 'react'
import { Button, Flex, Text } from '@/adapters/ui'
import { ChartFlow } from '@/adapters/ui/icons'
import { useLayoutStore } from '@/features/layout/store'
import type { ActivityPanelProps } from '@/shared/context'
import type { ExecutionEventV2 } from '../contract'
import { describeRun, projectRun } from '../projection'
import { useExecutionRun } from '../store'
import { buildTimeline } from './timeline-model'
import { ExecutionTimeline } from './ExecutionTimeline'

const NO_EVENTS: ExecutionEventV2[] = []

export const ActivityPanel = ({ jobId }: ActivityPanelProps): ReactNode => {
  const stored = useExecutionRun(jobId)
  const events = stored?.events ?? NO_EVENTS
  const jobStatus = stored?.jobStatus ?? null
  const run = useMemo(() => projectRun(events, jobStatus), [events, jobStatus])
  const timeline = useMemo(() => buildTimeline(events, run), [events, run])
  const openExecution = useLayoutStore((state) => state.openExecution)

  return (
    <Flex direction="col" gap="3" className="h-full overflow-y-auto p-4">
      <Flex justify="between" align="center" gap="2">
        <div>
          <Text kind="label/semibold/md">Agent activity</Text>
          {jobId && (
            <Text kind="body/regular/xs" className="text-secondary block">
              {describeRun(run)}
            </Text>
          )}
        </div>
        {jobId && (
          <Button kind="secondary" size="small" onClick={() => openExecution(jobId)}>
            <Flex align="center" gap="1.5">
              <ChartFlow className="h-4 w-4" />
              Execution graph
            </Flex>
          </Button>
        )}
      </Flex>
      {jobId ? (
        <ExecutionTimeline timeline={timeline} />
      ) : (
        <Text kind="body/regular/sm">
          Ask a question to follow the agent’s tool and model calls.
        </Text>
      )}
    </Flex>
  )
}
