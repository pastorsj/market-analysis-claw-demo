// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ReactNode } from 'react'
import Image from 'next/image'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Badge, Text } from '@/adapters/ui'
import type { NodeLogo } from '../registry'
import styles from './graph.module.css'

/** What a canvas node shows. `kind` only styles it. */
export type CanvasNodeData = {
  label: string
  detail?: string | null
  state?: NodeState
  badges?: string[]
  /** Logos of the libraries behind the node, drawn before its label */
  logos?: readonly NodeLogo[]
  kind?: string
}

/** A node's state in a canvas: `idle` until something runs it. */
export type NodeState = 'idle' | 'running' | 'completed' | 'failed'

export type CanvasNode = Node<CanvasNodeData, 'step'>
export type GroupNode = Node<{ label: string }, 'group'>

const BADGE_LIMIT = 2

/** A card with a target handle on the left and a source handle on the right. */
export const StepNode = ({ data, selected }: NodeProps<CanvasNode>): ReactNode => {
  const badges = data.badges ?? []
  const logos = data.logos ?? []
  return (
    <div
      className={styles.node}
      data-kind={data.kind}
      data-state={data.state ?? 'idle'}
      data-selected={selected || undefined}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className={styles.title}>
        {logos.map((logo) => (
          <Image
            key={logo.brand}
            className={styles.logo}
            src={logo.src}
            alt={logo.brand}
            title={logo.brand}
            data-brand={logo.brand}
            width={18}
            height={18}
            unoptimized
          />
        ))}
        <Text kind="label/semibold/sm" className={styles.label}>
          {data.label}
        </Text>
      </span>
      {data.detail && <span className={styles.detail}>{data.detail}</span>}
      {badges.length > 0 && (
        <span className={styles.badges}>
          {badges.slice(0, BADGE_LIMIT).map((badge) => (
            <Badge key={badge} kind="outline" color="green" className={styles.badge} title={badge}>
              {badge}
            </Badge>
          ))}
          {badges.length > BADGE_LIMIT && (
            <Badge kind="outline" color="gray" title={badges.slice(BADGE_LIMIT).join(', ')}>
              +{badges.length - BADGE_LIMIT}
            </Badge>
          )}
        </span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}

/** A labelled box drawn behind other nodes, e.g. the OpenShell sandbox. */
export const GroupBox = ({ data }: NodeProps<GroupNode>): ReactNode => (
  <div className={styles.group}>
    <span className={styles.groupLabel}>{data.label}</span>
  </div>
)
