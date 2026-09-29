// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The API's read-only view of a structured data source (live mode):
 *
 * - `GET  /v1/data_sources/{id}/schema`                  tables, columns, relationships
 * - `GET  /v1/data_sources/{id}/preview?table=&limit=`   first rows of a table
 * - `POST /v1/data_sources/{id}/query` `{sql}`           one bounded read-only query
 * - `GET  /v1/data_sources/{id}/ontology`                Auto Ontology's graph (ontology profile)
 *
 * The API bounds every result; errors come back as `{detail}`.
 */

export type Value = string | number | boolean | null

export interface ColumnInfo {
  name: string
  type: string
  description?: string | null
}

export interface TableInfo {
  name: string
  description?: string | null
  columns: ColumnInfo[]
}

export interface Relationship {
  from_table: string
  from_column: string
  to_table: string
  to_column: string
}

export interface DatabaseSchema {
  source_id: string
  database_name: string
  tables: TableInfo[]
  relationships: Relationship[]
}

export interface QueryResult {
  columns: string[]
  rows: Value[][]
  truncated: boolean
  duration_ms: number
}

/** The parts of the API's `OntologySnapshot` the viewer draws. */
export interface OntologySnapshot {
  truncated: boolean
  /** `kind` is e.g. `table`, `column` or `term` (an ontology object) */
  nodes: { id: string; kind: string; label: string }[]
  /** `kind` is e.g. `represents` (term → table) or `contains` */
  edges: { kind: string; source: string; target: string }[]
}

const PREVIEW_ROWS = 20

const sourceUrl = (sourceId: string) => `/api/v1/data_sources/${encodeURIComponent(sourceId)}`

const readBody = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail
    throw new Error(
      typeof detail === 'string' ? detail : `The request failed (${response.status}).`
    )
  }
  return body as T
}

const request = async <T>(url: string, init?: RequestInit): Promise<T> =>
  readBody<T>(await fetch(url, { cache: 'no-store', ...init }))

export const getSchema = (sourceId: string, signal?: AbortSignal): Promise<DatabaseSchema> =>
  request(`${sourceUrl(sourceId)}/schema`, { signal })

export const getPreview = (
  sourceId: string,
  table: string,
  signal?: AbortSignal
): Promise<QueryResult> =>
  request(
    `${sourceUrl(sourceId)}/preview?table=${encodeURIComponent(table)}&limit=${PREVIEW_ROWS}`,
    {
      signal,
    }
  )

export const runQuery = (
  sourceId: string,
  sql: string,
  signal?: AbortSignal
): Promise<QueryResult> =>
  request(`${sourceUrl(sourceId)}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
    signal,
  })

/** Null when there is no ontology: the API answers 404 unless Auto Ontology is running. */
export const getOntology = async (
  sourceId: string,
  signal?: AbortSignal
): Promise<OntologySnapshot | null> => {
  const response = await fetch(`${sourceUrl(sourceId)}/ontology`, { cache: 'no-store', signal })
  return response.status === 404 ? null : readBody<OntologySnapshot>(response)
}
