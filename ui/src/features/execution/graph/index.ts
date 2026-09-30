// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import dynamic from 'next/dynamic'

/** React Flow loads only when an explorer or the data viewer draws a graph. */
export const FlowCanvas = dynamic(
  () => import('./FlowCanvas').then((module) => module.FlowCanvas),
  {
    ssr: false,
  }
)

export type { CanvasItem } from './FlowCanvas'
export { ExecutionGraph } from './ExecutionGraph'
export { buildGpuAccelerationByNode, type ExecutionNodeGpuAcceleration } from './gpu-acceleration'
export {
  toGraphEvent,
  toGraphProjection,
  type GraphComponent,
  type GraphEvent,
  type GraphProjection,
} from './graph-events'
export {
  buildExecutionGraphViewModel,
  buildExecutionNodeDetail,
  isInspectableExecutionNodeState,
  isInspectableNode,
  nodeIdsForEvent,
  TOOL_NODE_BY_NAME,
  type ExecutionGraphViewModel,
  type ExecutionNodeDetail,
  type ExecutionNodeId,
  type InspectableExecutionNodeId,
} from './graph-model'
