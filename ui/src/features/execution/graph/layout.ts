// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Layered left-to-right layout: a node's column is one past its deepest
 * parent (longest path), and each column is centered vertically. Enough for
 * the small DAGs here, with no layout library.
 */

export interface Size {
  width: number
  height: number
}

export interface Edge {
  source: string
  target: string
}

export type Positions = Map<string, { x: number; y: number }>

const COLUMN_GAP = 56
const ROW_GAP = 20

export const layeredLayout = (nodeIds: string[], edges: Edge[], size: Size): Positions => {
  const parents = new Map(nodeIds.map((id) => [id, [] as string[]]))
  for (const edge of edges) parents.get(edge.target)?.push(edge.source)

  const columns = new Map<string, number>()
  const visiting = new Set<string>()
  const columnOf = (id: string): number => {
    const known = columns.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return -1 // a cycle: break it here
    visiting.add(id)
    const column = Math.max(-1, ...(parents.get(id) ?? []).map(columnOf)) + 1
    columns.set(id, column)
    return column
  }

  const byColumn = new Map<number, string[]>()
  for (const id of nodeIds) byColumn.set(columnOf(id), [...(byColumn.get(columnOf(id)) ?? []), id])

  const rowHeight = size.height + ROW_GAP
  const tallest = Math.max(0, ...[...byColumn.values()].map((ids) => ids.length))
  const positions: Positions = new Map()
  for (const [column, ids] of byColumn) {
    const top = ((tallest - ids.length) * rowHeight) / 2
    ids.forEach((id, row) =>
      positions.set(id, { x: column * (size.width + COLUMN_GAP), y: top + row * rowHeight })
    )
  }
  return positions
}
