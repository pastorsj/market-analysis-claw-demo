// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Display formatting shared by the execution views. */

export const formatDuration = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '–'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

export const formatCount = (value: number | null): string =>
  value === null ? '–' : new Intl.NumberFormat('en-US').format(value)

/** "1 call", "2 calls" */
export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

export const formatNumber = (value: number, digits = 3): string =>
  Number.isInteger(value) ? formatCount(value) : value.toPrecision(digits)

/** Milliseconds between two ISO timestamps. */
export const elapsedMs = (from: string, to: string): number => Date.parse(to) - Date.parse(from)

/** Any JSON value as one line of text for a table cell. */
export const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return '–'
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
