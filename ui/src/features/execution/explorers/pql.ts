// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** `predict_asset_outcomes`: a curated PQL template scored per asset by NVIDIA Kumo. */

import type { StructuredPrediction } from '@/generated/receipt'
import { chart, facts, sections } from './sections'
import type { EvidenceSection } from './types'

export const pqlSections = (content: StructuredPrediction): EvidenceSection[] =>
  sections(
    facts('Prediction', [
      ['Template', content.templateId],
      ['Anchor', content.anchor],
      ['Horizon', `${content.horizon.value} ${content.horizon.unit}`],
      ['Model', content.model],
      ['Not available', content.available ? null : (content.reason ?? 'No reason given')],
    ]),
    { kind: 'code', title: 'PQL', language: 'pql', code: content.pql },
    chart({
      type: 'hbar',
      title: 'Outcome probability by asset',
      x: { key: 'asset' },
      y: { format: 'percent' },
      series: [{ key: 'probability', label: 'Probability' }],
      data: content.rows.map((row) => ({ asset: row.assetId, probability: row.probability })),
    })
  )
