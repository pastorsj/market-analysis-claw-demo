// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A read-only React Flow canvas for small DAGs: our layered layout, fixed node
 * sizes and static handles (so edges render without measuring the DOM), pan,
 * zoom, fit and keyboard selection. Used for the execution graph and the
 * ontology lineage. Load it through `./index` (next/dynamic).
 */

'use client'

import { useMemo, type ReactNode } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge as FlowEdge,
  type NodeChange,
} from '@xyflow/react'
import { useLayoutStore } from '@/features/layout/store'
import { layeredLayout, type Edge, type Size } from './layout'
import {
  GroupBox,
  StepNode,
  type CanvasNode,
  type CanvasNodeData,
  type GroupNode,
} from './GraphNode'
import styles from './graph.module.css'

export type CanvasItem = CanvasNodeData & { id: string }

export interface FlowCanvasProps {
  nodes: CanvasItem[]
  edges: Edge[]
  nodeSize: Size
  /** Canvas height, e.g. 260 or '100%'; the width follows the container */
  height: number | string
  ariaLabel: string
  selectedId?: string | null
  /** Makes nodes selectable by click, Enter or Space */
  onSelect?: (id: string) => void
  /** Draws a labelled box around one node */
  group?: { nodeId: string; label: string }
}

const NODE_TYPES = { step: StepNode, group: GroupBox }
const GROUP_PADDING = 14
const GROUP_LABEL_HEIGHT = 18

export const FlowCanvas = ({
  nodes,
  edges,
  nodeSize,
  height,
  ariaLabel,
  selectedId = null,
  onSelect,
  group,
}: FlowCanvasProps): ReactNode => {
  const colorMode = useLayoutStore((state) => state.theme)

  const flowNodes = useMemo(() => {
    const { width, height: nodeHeight } = nodeSize
    const positions = layeredLayout(
      nodes.map((node) => node.id),
      edges,
      nodeSize
    )
    const steps: (CanvasNode | GroupNode)[] = nodes.map(({ id, ...data }) => ({
      id,
      type: 'step',
      data,
      position: positions.get(id)!,
      width,
      height: nodeHeight,
      selected: id === selectedId,
      selectable: Boolean(onSelect),
      ariaLabel: data.state ? `${data.label}, ${data.state}` : data.label,
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
      handles: [
        { type: 'target', position: Position.Left, x: 0, y: nodeHeight / 2 },
        { type: 'source', position: Position.Right, x: width, y: nodeHeight / 2 },
      ],
    }))
    const anchor = group && positions.get(group.nodeId)
    if (!group || !anchor) return steps
    const box: GroupNode = {
      id: `group:${group.nodeId}`,
      type: 'group',
      data: { label: group.label },
      position: {
        x: anchor.x - GROUP_PADDING,
        y: anchor.y - GROUP_PADDING - GROUP_LABEL_HEIGHT,
      },
      width: width + 2 * GROUP_PADDING,
      height: nodeHeight + 2 * GROUP_PADDING + GROUP_LABEL_HEIGHT,
      selectable: false,
      focusable: false,
      zIndex: -1,
    }
    return [box, ...steps]
  }, [nodes, edges, nodeSize, selectedId, onSelect, group])

  const flowEdges = useMemo<FlowEdge[]>(() => {
    const running = new Set(nodes.filter((node) => node.state === 'running').map((node) => node.id))
    return edges.map(({ source, target }) => ({
      id: `${source}->${target}`,
      source,
      target,
      animated: running.has(target),
      markerEnd: { type: MarkerType.ArrowClosed },
    }))
  }, [nodes, edges])

  const selectNode = (changes: NodeChange[]) => {
    const picked = changes.find((change) => change.type === 'select' && change.selected)
    if (picked?.type === 'select') onSelect?.(picked.id)
  }

  return (
    <div className={styles.canvas} style={{ height }} aria-label={ariaLabel} role="figure">
      <ReactFlow
        // Refit when nodes appear during a live run
        key={nodes.length}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={selectNode}
        colorMode={colorMode}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.3}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable={Boolean(onSelect)}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
