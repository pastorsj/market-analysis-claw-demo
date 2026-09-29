// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An explorer turns one receipt into a list of sections. Builders are pure
 * functions; CapabilityExplorer renders every section kind the same way for
 * every tool.
 */

import type { ChartSpec } from '@/shared/components/ResultChart'
import type { CanvasItem } from '../graph'
import type { Edge } from '../graph/layout'

export type Cell = string | number | null

export interface Fact {
  label: string
  value: string
}

export interface Passage {
  id: string
  title: string
  text: string
  /** e.g. "market_news · 2026-08-01" */
  source: string
  url: string | null
  citation: string | null
  score: string
}

export type EvidenceSection =
  | { kind: 'facts'; title: string; facts: Fact[] }
  | { kind: 'code'; title: string; language: 'sql' | 'pql'; code: string }
  | { kind: 'table'; title: string; columns: string[]; rows: Cell[][]; note?: string }
  | { kind: 'chart'; title: string; spec: ChartSpec }
  | { kind: 'passages'; title: string; passages: Passage[] }
  | { kind: 'graph'; title: string; nodes: CanvasItem[]; edges: Edge[] }
  | { kind: 'notes'; title: string; notes: string[] }
