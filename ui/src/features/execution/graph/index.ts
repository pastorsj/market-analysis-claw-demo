// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import dynamic from 'next/dynamic'

/** React Flow loads only when a graph is shown, so chat pages don't pay for it. */
export const FlowCanvas = dynamic(
  () => import('./FlowCanvas').then((module) => module.FlowCanvas),
  {
    ssr: false,
  }
)

export type { CanvasItem } from './FlowCanvas'
export { buildExecutionGraph, type ExecutionGraphModel, type GraphNode } from './view-model'
