// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The execution graph of one run:
 *
 *   Question → Hermes agent → Switchyard router ─────────────→ Answer
 *                          └→ tool (one per tool used) → resource ┘
 *
 * Tools and resources come from the run's tool calls and the registry. The
 * shape comes from the whole run so it stays still during replay; node states
 * come from the events up to the replay cursor.
 */

import type { ReceiptV2 } from '../contract'
import { plural, shortModel } from '../format'
import type { CallState, RunProjection, ToolCall } from '../projection'
import { RESOURCES } from '../registry'
import type { Edge } from './layout'

export type NodeKind = 'question' | 'agent' | 'router' | 'tool' | 'resource' | 'answer'
export type NodeState = 'idle' | CallState

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  detail: string | null
  /** What the node stands for, shown in its explorer */
  description: string | null
  state: NodeState
  badges: string[]
  /** The visible tool calls behind a tool or resource node */
  invocationIds: string[]
}

export interface ExecutionGraphModel {
  nodes: GraphNode[]
  edges: Edge[]
}

const RUN_NODE_STATE: Record<RunProjection['status'], NodeState> = {
  waiting: 'idle',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
}

const combinedState = (calls: ToolCall[]): NodeState => {
  if (calls.some((call) => call.state === 'running')) return 'running'
  if (calls.some((call) => call.state === 'failed')) return 'failed'
  return calls.length ? 'completed' : 'idle'
}

/** "model · tier ×n" for each model Switchyard served. */
const servedModelBadges = (run: RunProjection): string[] => {
  const counts = new Map<string, number>()
  for (const call of run.modelCalls) {
    if (!call.servedModel) continue
    const badge = [shortModel(call.servedModel), call.tier].filter(Boolean).join(' · ')
    counts.set(badge, (counts.get(badge) ?? 0) + 1)
  }
  return [...counts].map(([badge, count]) => (count > 1 ? `${badge} ×${count}` : badge))
}

/** What the receipts say ran behind a resource: the engine, index or model. */
const resourceBadges = (calls: ToolCall[], receipts: Record<string, ReceiptV2>): string[] => {
  const badges = new Set<string>()
  for (const receipt of calls.flatMap((call) => call.receiptIds.map((id) => receipts[id]))) {
    if (!receipt?.content) continue
    if (receipt.artifactKind === 'analytics_result' && receipt.content.engine) {
      const { device, library } = receipt.content.engine
      badges.add(`${device.toUpperCase()} · ${library}`)
    } else if (receipt.artifactKind === 'retrieval_evidence') {
      badges.add(`${receipt.content.index.type} · ${shortModel(receipt.content.models.embed)}`)
    } else if (receipt.artifactKind === 'structured_prediction' && receipt.content.model) {
      badges.add(shortModel(receipt.content.model))
    }
  }
  return [...badges]
}

export const buildExecutionGraph = (
  visible: RunProjection,
  whole: RunProjection,
  receipts: Record<string, ReceiptV2>
): ExecutionGraphModel => {
  const runState = RUN_NODE_STATE[visible.status]
  const node = (
    partial: Pick<GraphNode, 'id' | 'kind' | 'label'> & Partial<GraphNode>
  ): GraphNode => ({
    detail: null,
    description: null,
    state: 'idle',
    badges: [],
    invocationIds: [],
    ...partial,
  })
  const nodes: GraphNode[] = [
    node({
      id: 'question',
      kind: 'question',
      label: 'Question',
      state: whole.startedAt ? 'completed' : 'idle',
    }),
    node({
      id: 'agent',
      kind: 'agent',
      label: 'Hermes agent',
      detail: plural(visible.toolCalls.length, 'tool call'),
      state: runState,
    }),
    node({
      id: 'router',
      kind: 'router',
      label: 'Switchyard router',
      detail: plural(visible.modelCalls.length, 'model call'),
      state: visible.modelCalls.length ? 'completed' : 'idle',
      badges: servedModelBadges(visible),
    }),
  ]
  const edges: Edge[] = [
    { source: 'question', target: 'agent' },
    { source: 'agent', target: 'router' },
    { source: 'router', target: 'answer' },
  ]

  const toolNames = [...new Set(whole.toolCalls.map((call) => call.name))]
  for (const name of toolNames) {
    const sample = whole.toolCalls.find((call) => call.name === name)!
    const calls = visible.toolCalls.filter((call) => call.name === name)
    const id = `tool:${name}`
    nodes.push(
      node({
        id,
        kind: 'tool',
        label: sample.label,
        description: sample.tool?.description ?? null,
        detail: sample.tool
          ? plural(calls.length, 'call')
          : `Other tool · ${plural(calls.length, 'call')}`,
        state: combinedState(calls),
        invocationIds: calls.map((call) => call.invocationId),
      })
    )
    edges.push({ source: 'agent', target: id })
    edges.push({ source: id, target: sample.family ? `resource:${sample.family}` : 'answer' })
  }

  const families = [...new Set(whole.toolCalls.flatMap((call) => call.family ?? []))]
  for (const family of families) {
    const calls = visible.toolCalls.filter((call) => call.family === family)
    const id = `resource:${family}`
    nodes.push(
      node({
        id,
        kind: 'resource',
        label: RESOURCES[family].label,
        detail: RESOURCES[family].detail,
        description: RESOURCES[family].detail,
        state: combinedState(calls),
        badges: resourceBadges(calls, receipts),
        invocationIds: calls.map((call) => call.invocationId),
      })
    )
    edges.push({ source: id, target: 'answer' })
  }

  const answerState =
    visible.status === 'completed' ? 'completed' : runState === 'failed' ? 'failed' : 'idle'
  nodes.push(node({ id: 'answer', kind: 'answer', label: 'Answer', state: answerState }))
  return { nodes, edges }
}
