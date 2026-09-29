// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ReactNode } from 'react'
import { Button, Flex, Slider, Text } from '@/adapters/ui'
import type { Replay } from './use-replay'

interface ReplayControlsProps {
  replay: Replay
  /** What the event at the cursor was */
  currentLabel: string | null
}

export const ReplayControls = ({ replay, currentLabel }: ReplayControlsProps): ReactNode => {
  const { step, total, playing } = replay
  return (
    <Flex align="center" gap="3" className="w-full">
      <Button
        kind="secondary"
        size="small"
        disabled={total === 0}
        onClick={playing ? replay.pause : replay.play}
      >
        {playing ? 'Pause' : step >= total ? 'Replay' : 'Play'}
      </Button>
      <Slider
        className="min-w-32 flex-1"
        min={0}
        max={Math.max(total, 1)}
        step={1}
        value={step}
        disabled={total === 0}
        onValueChange={replay.seek}
        stepPosition="none"
        aria-label="Replay step"
      />
      <Text kind="body/regular/xs" className="text-secondary min-w-48 truncate" aria-live="polite">
        Step {step} of {total}
        {currentLabel ? ` · ${currentLabel}` : ''}
      </Text>
    </Flex>
  )
}
