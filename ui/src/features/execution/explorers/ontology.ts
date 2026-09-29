// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto Ontology `ask_question`: how each phrase of the question was grounded
 * (phrase → ontology object → table.column), then the SQL answer.
 */

import type { StructuredQuery } from '@/generated/receipt'
import type { CanvasItem } from '../graph'
import type { Edge } from '../graph/layout'
import { objectTable, sections } from './sections'
import { sqlSections } from './sql'
import type { EvidenceSection } from './types'

const lineageGraph = (content: StructuredQuery): { nodes: CanvasItem[]; edges: Edge[] } => {
  const nodes = new Map<string, CanvasItem>()
  const edges = new Map<string, Edge>()
  const link = (source: string, target: string) =>
    edges.set(`${source}->${target}`, { source, target })

  for (const binding of content.resolutionLineage) {
    const phrase = `phrase:${binding.phrase}`
    const object = `object:${binding.ontologyObject}`
    const column = `column:${binding.table}.${binding.column}`
    nodes.set(phrase, {
      id: phrase,
      label: `“${binding.phrase}”`,
      detail: 'Question phrase',
      kind: 'phrase',
    })
    nodes.set(object, {
      id: object,
      label: binding.ontologyObject,
      detail: 'Ontology object',
      kind: 'object',
    })
    nodes.set(column, {
      id: column,
      label: `${binding.table}.${binding.column}`,
      detail: 'Column',
      kind: 'column',
    })
    link(phrase, object)
    link(object, column)
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

export const ontologySections = (content: StructuredQuery): EvidenceSection[] => {
  const lineage = lineageGraph(content)
  return sections(
    lineage.nodes.length > 0 && { kind: 'graph', title: 'Grounding', ...lineage },
    objectTable('Resolution lineage', content.resolutionLineage),
    ...sqlSections(content)
  )
}
