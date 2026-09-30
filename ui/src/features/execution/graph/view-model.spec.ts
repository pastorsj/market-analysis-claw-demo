// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { projectRun } from '../projection'
import { fixtureEvents, fixtureReceipts } from '../test-utils/fixtures'
import { layeredLayout } from './layout'
import { buildExecutionGraph } from './view-model'

const whole = projectRun(fixtureEvents)
const receipts = Object.fromEntries(fixtureReceipts.map((receipt) => [receipt.receiptId, receipt]))
const node = (graph: ReturnType<typeof buildExecutionGraph>, id: string) =>
  graph.nodes.find((candidate) => candidate.id === id)!

describe('layeredLayout', () => {
  const size = { width: 100, height: 40 }

  it('puts each node one column past its deepest parent and centers short columns', () => {
    const positions = layeredLayout(
      ['a', 'b', 'c', 'd'],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
      ],
      size
    )
    expect(positions.get('a')).toEqual({ x: 0, y: 30 })
    expect(positions.get('b')).toEqual({ x: 156, y: 0 })
    expect(positions.get('c')).toEqual({ x: 156, y: 60 })
    expect(positions.get('d')).toEqual({ x: 312, y: 30 })
  })

  it('breaks a cycle instead of recursing forever', () => {
    const positions = layeredLayout(
      ['a', 'b'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
      size
    )
    expect(positions.size).toBe(2)
  })
})

describe('buildExecutionGraph', () => {
  it('draws the golden run: agent, router, one node per tool and per resource, answer', () => {
    const graph = buildExecutionGraph(whole, whole, receipts)
    expect(graph.nodes.map((n) => [n.id, n.state])).toEqual([
      ['question', 'completed'],
      ['agent', 'completed'],
      ['router', 'completed'],
      ['tool:market_anomaly_scan', 'completed'],
      ['tool:retrieve_evidence', 'completed'],
      ['resource:market_analytics', 'completed'],
      ['resource:unstructured_retrieval', 'completed'],
      ['answer', 'completed'],
    ])
    expect(graph.edges).toContainEqual({
      source: 'tool:market_anomaly_scan',
      target: 'resource:market_analytics',
    })
    expect(graph.edges).toContainEqual({
      source: 'resource:unstructured_retrieval',
      target: 'answer',
    })
  })

  it('shows the served models on the router and the engine on each resource', () => {
    const graph = buildExecutionGraph(whole, whole, receipts)
    expect(node(graph, 'router').badges).toEqual([
      'nemotron-3-ultra-550b-a55b · efficient',
      'gpt-6-sol · capable',
    ])
    expect(node(graph, 'resource:market_analytics').badges).toEqual(['GPU · cuml.accel'])
    expect(node(graph, 'resource:unstructured_retrieval').badges).toEqual([
      'HNSW · nemotron-3-embed-1b',
    ])
  })

  it('draws the LangChain logo on the retrieval tool and no logo elsewhere', () => {
    const graph = buildExecutionGraph(whole, whole, receipts)
    expect(node(graph, 'tool:retrieve_evidence').logos).toEqual([
      { brand: 'LangChain', src: '/ecosystem-logos/langchain.svg' },
    ])
    const others = graph.nodes.filter((n) => n.id !== 'tool:retrieve_evidence')
    expect(others.flatMap((n) => n.logos)).toEqual([])
    // Milvus and its Nemotron embedder stay on the retrieval resource
    expect(node(graph, 'resource:unstructured_retrieval')).toMatchObject({
      label: 'Milvus',
      badges: ['HNSW · nemotron-3-embed-1b'],
    })
  })

  it('keeps the whole run’s shape at a replay cursor and marks what has not happened', () => {
    const graph = buildExecutionGraph(projectRun(fixtureEvents.slice(0, 2)), whole, receipts)
    expect(graph.nodes).toHaveLength(8)
    expect(node(graph, 'agent').state).toBe('running')
    expect(node(graph, 'router').badges).toEqual(['nemotron-3-ultra-550b-a55b · efficient'])
    expect(node(graph, 'tool:retrieve_evidence').state).toBe('idle')
    expect(node(graph, 'answer').state).toBe('idle')
  })

  it('links a tool the registry does not know straight to the answer', () => {
    const run = projectRun([{ ...fixtureEvents[2], toolName: 'web_search' }])
    const graph = buildExecutionGraph(run, run, {})
    expect(node(graph, 'tool:web_search').detail).toBe('Other tool · 1 call')
    expect(graph.edges).toContainEqual({ source: 'tool:web_search', target: 'answer' })
  })
})
