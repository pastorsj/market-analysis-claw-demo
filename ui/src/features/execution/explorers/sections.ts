// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Small constructors the explorer builders share. Empty sections become null. */

import type { ChartSpec } from '@/shared/components/ResultChart'
import { cellText } from '../format'
import type { Cell, EvidenceSection } from './types'

type Section = EvidenceSection | null | undefined | false

/** Drops the empty sections. */
export const sections = (...list: Section[]): EvidenceSection[] =>
  list.filter((section): section is EvidenceSection => Boolean(section))

/** Label/value facts; entries without a value are left out. */
export const facts = (title: string, entries: [string, unknown][]): Section => {
  const kept = entries
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) => ({ label, value: cellText(value) }))
  return kept.length > 0 && { kind: 'facts', title, facts: kept }
}

export const notes = (title: string, list: string[]): Section =>
  list.length > 0 && { kind: 'notes', title, notes: list }

/** A table from objects: one column per key, in first-seen order. */
export const objectTable = (title: string, list: readonly object[], note?: string): Section => {
  if (list.length === 0) return null
  const entries = list.map((item) => new Map(Object.entries(item)))
  const columns = [...new Set(entries.flatMap((entry) => [...entry.keys()]))]
  const rows = entries.map((entry) => columns.map((column) => toCell(entry.get(column))))
  return { kind: 'table', title, columns, rows, note }
}

/** ResultChart takes at most 60 rows and 6 series. */
const MAX_CHART_ROWS = 60
const MAX_CHART_SERIES = 6

export const chart = (spec: ChartSpec): Section =>
  spec.data.length > 0 && {
    kind: 'chart',
    title: spec.title,
    spec: {
      ...spec,
      series: spec.series.slice(0, MAX_CHART_SERIES),
      data: spec.data.slice(0, MAX_CHART_ROWS),
    },
  }

export const toCell = (value: unknown): Cell =>
  typeof value === 'number' || value === null ? value : cellText(value)

/** A payload list as records, ignoring anything that is not an object. */
export const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
      )
    : []

export const numberOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** The date part of an ISO timestamp. */
export const day = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 10) : '')
