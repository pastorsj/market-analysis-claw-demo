// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test-utils'
import { FlowCanvas } from './FlowCanvas'

const NODES = [
  { id: 'question', label: 'Question', state: 'completed' as const },
  { id: 'agent', label: 'Hermes agent', detail: '2 tool calls', state: 'running' as const },
  { id: 'router', label: 'Switchyard router', badges: ['gpt-6-sol · capable'] },
]
const EDGES = [
  { source: 'question', target: 'agent' },
  { source: 'agent', target: 'router' },
]

describe('FlowCanvas', () => {
  it('renders nodes, edges, the group box and the attribution without measuring the DOM', () => {
    const { container } = render(
      <FlowCanvas
        nodes={NODES}
        edges={EDGES}
        nodeSize={{ width: 200, height: 80 }}
        height={300}
        ariaLabel="Execution graph"
        group={{ nodeId: 'agent', label: 'OpenShell sandbox' }}
      />
    )
    expect(screen.getByRole('figure', { name: 'Execution graph' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Hermes agent, running' })).toBeInTheDocument()
    expect(screen.getByText('gpt-6-sol · capable')).toBeInTheDocument()
    expect(container.querySelectorAll('.react-flow__node-step')).toHaveLength(3)
    expect(container.querySelectorAll('.react-flow__node-group')).toHaveLength(1)
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(2)
    expect(container.querySelector('.react-flow__attribution')).not.toBeNull()
  })

  it('reports the selected node on click and on Enter', () => {
    const onSelect = vi.fn()
    render(
      <FlowCanvas
        nodes={NODES}
        edges={EDGES}
        nodeSize={{ width: 200, height: 80 }}
        height={300}
        ariaLabel="Execution graph"
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByRole('group', { name: 'Switchyard router' }))
    fireEvent.keyDown(screen.getByRole('group', { name: 'Question, completed' }), { key: 'Enter' })
    expect(onSelect.mock.calls).toEqual([['router'], ['question']])
  })
})
