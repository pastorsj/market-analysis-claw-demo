// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Receipt → sections. The receipt's `artifactKind` picks the builder and
 * TypeScript checks every kind has one; the registry's `explorer` chooses
 * between the SQL and ontology views of a structured query.
 */

import type { ReceiptV2 } from '../contract'
import { formatDuration } from '../format'
import { toolFor, type Tool } from '../registry'
import { marketSections } from './market'
import { ontologySections } from './ontology'
import { pqlSections } from './pql'
import { retrievalSections } from './retrieval'
import { facts, sections } from './sections'
import { sqlSections } from './sql'
import type { EvidenceSection } from './types'

export type { EvidenceSection } from './types'

const contentSections = (receipt: ReceiptV2, explorer: Tool['explorer'] | undefined) => {
  switch (receipt.artifactKind) {
    case 'retrieval_evidence':
      return receipt.content ? retrievalSections(receipt.content) : []
    case 'analytics_result':
      return receipt.content ? marketSections(receipt.content) : []
    case 'structured_query':
      if (!receipt.content) return []
      return explorer === 'sql' ? sqlSections(receipt.content) : ontologySections(receipt.content)
    case 'structured_prediction':
      return receipt.content ? pqlSections(receipt.content) : []
  }
}

export const explorerSections = (receipt: ReceiptV2): EvidenceSection[] => {
  const tool = toolFor(receipt.toolName)
  return sections(
    facts('Call', [
      ['Tool', tool?.label ?? receipt.toolName],
      ['Status', receipt.status],
      ['Duration', formatDuration(receipt.durationMs)],
      ['Error', receipt.errorType && `${receipt.errorType}: ${receipt.errorSummary ?? ''}`],
    ]),
    ...contentSections(receipt, tool?.explorer)
  )
}
