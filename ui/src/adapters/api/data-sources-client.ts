// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Data Sources API Client
 *
 * Fetches the data sources of the active data pack: from the API
 * (`GET /v1/data_sources`) in live mode, or from the recordings bundle's
 * `pack.json` snapshot in replay mode.
 */

export interface DataSourceFromAPI {
  /** Unique identifier for the data source */
  id: string
  /** Display name for the source */
  name: string
  /** Brief description of the source */
  description?: string | null
  /** Whether the source starts enabled (defaults to true) */
  default_enabled?: boolean
  /** The structured source's database; null for document sources */
  database_name?: string | null
}

/**
 * Get the available data sources.
 *
 * The API returns either a bare array or `{ data_sources: [...] }`.
 */
export const fetchDataSources = async (signal?: AbortSignal): Promise<DataSourceFromAPI[]> => {
  const response = await fetch('/api/v1/data_sources', { signal })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body?.error?.message || `Failed to fetch data sources: ${response.status}`)
  }
  const data = await response.json()
  return Array.isArray(data) ? data : (data.data_sources ?? [])
}

/** The data sources in the replay bundle's `pack.json` snapshot (replay mode). */
export const fetchRecordedDataSources = async (
  signal?: AbortSignal
): Promise<DataSourceFromAPI[]> => {
  const response = await fetch('/api/recordings/pack.json', { signal })
  if (!response.ok) throw new Error(`Failed to load the recorded data sources: ${response.status}`)
  const pack: { sources?: { id: string; name: string; description?: string | null }[] } =
    await response.json()
  return (pack.sources ?? []).map(({ id, name, description }) => ({ id, name, description }))
}
