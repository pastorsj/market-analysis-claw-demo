// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** A SQL answer: the question, the query that ran and the rows it returned. */

import type { StructuredQuery } from '@/generated/receipt'
import { facts, objectTable, sections } from './sections'
import type { EvidenceSection } from './types'

export const sqlSections = (content: StructuredQuery): EvidenceSection[] =>
  sections(
    facts('Question', [
      ['Question', content.query],
      ['Database', content.databaseName],
      ['Answer', content.answer],
    ]),
    content.sql !== null && { kind: 'code', title: 'SQL', language: 'sql', code: content.sql },
    objectTable(
      `Rows (${content.rows.length})`,
      content.rows,
      content.truncated
        ? `Showing ${content.rows.length} of ${content.sourceRowCount} rows.`
        : undefined
    )
  )
