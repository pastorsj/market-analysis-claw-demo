// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The API's read-only view of a structured data source (live mode):
 *
 * - `GET  /v1/data_sources/{id}/schema`                  tables, views, columns, keys
 * - `GET  /v1/data_sources/{id}/preview?table=&limit=`   first rows of a table
 * - `POST /v1/data_sources/{id}/query` `{sql}`           one bounded read-only query
 *
 * The API bounds every result; errors come back as `{detail}`. Every pack's
 * structured source is one DuckDB database.
 */

export type Value = string | number | boolean | null

export interface DatabaseColumn {
  name: string
  dataType: string
  nullable?: boolean
  primaryKey?: boolean
}

export interface DatabaseTable {
  /** Bare table name */
  name: string
  schemaName: string
  /** How queries and previews name it: bare in `main`, `schema.table` elsewhere */
  qualifiedName: string
  tableType: string
  columns: DatabaseColumn[]
}

export interface DatabaseRelationship {
  /** `schema.table.column` of the foreign key */
  source: string
  /** `schema.table.column` it references */
  target: string
  sourceTable: string
  targetTable: string
}

export interface DatabaseSnapshot {
  sourceId: string
  databaseName: string
  provider: string
  schemas: Array<{ name: string; tables: DatabaseTable[] }>
  relationships: DatabaseRelationship[]
}

export interface QueryResult {
  columns: Array<{ name: string; dataType: string | null }>
  rows: Value[][]
  truncated: boolean
  durationMs: number
}

/** `GET /schema` as the API sends it. */
interface SchemaResponse {
  source_id: string
  database_name: string
  tables: Array<{
    name: string
    schema: string
    kind: string
    columns: Array<{ name: string; type: string; nullable?: boolean; primary_key?: boolean }>
  }>
  relationships: Array<{
    from_table: string
    from_column: string
    to_table: string
    to_column: string
  }>
}

/** `GET /preview` and `POST /query` as the API sends them. */
interface QueryResponse {
  columns: string[]
  types?: string[]
  rows: Value[][]
  truncated: boolean
  duration_ms: number
}

export const PREVIEW_ROWS = 8

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

const toSnapshot = (schema: SchemaResponse): DatabaseSnapshot => {
  const schemas = new Map<string, DatabaseTable[]>()
  for (const table of schema.tables) {
    const tables = schemas.get(table.schema) ?? []
    tables.push({
      name: table.name.slice(table.name.lastIndexOf('.') + 1),
      schemaName: table.schema,
      qualifiedName: table.name,
      tableType: table.kind,
      columns: table.columns.map((column) => ({
        name: column.name,
        dataType: column.type,
        nullable: column.nullable,
        primaryKey: column.primary_key,
      })),
    })
    schemas.set(table.schema, tables)
  }
  // Relationships name each column in full: schema.table.column
  const fullName = new Map(
    [...schemas.values()]
      .flat()
      .map((table) => [table.qualifiedName, `${table.schemaName}.${table.name}`])
  )
  const column = (table: string, name: string): string => `${fullName.get(table) ?? table}.${name}`
  return {
    sourceId: schema.source_id,
    databaseName: schema.database_name,
    provider: 'duckdb',
    schemas: [...schemas].map(([name, tables]) => ({ name, tables })),
    relationships: schema.relationships.map((relationship) => ({
      source: column(relationship.from_table, relationship.from_column),
      target: column(relationship.to_table, relationship.to_column),
      sourceTable: relationship.from_table,
      targetTable: relationship.to_table,
    })),
  }
}

const toResult = (response: QueryResponse): QueryResult => ({
  columns: response.columns.map((name, index) => ({
    name,
    dataType: response.types?.[index] ?? null,
  })),
  rows: response.rows,
  truncated: response.truncated,
  durationMs: response.duration_ms,
})

export const getSnapshot = async (
  sourceId: string,
  signal?: AbortSignal
): Promise<DatabaseSnapshot> =>
  toSnapshot(await request<SchemaResponse>(`${sourceUrl(sourceId)}/schema`, { signal }))

export const getPreview = async (
  sourceId: string,
  table: string,
  signal?: AbortSignal
): Promise<QueryResult> =>
  toResult(
    await request<QueryResponse>(
      `${sourceUrl(sourceId)}/preview?table=${encodeURIComponent(table)}&limit=${PREVIEW_ROWS}`,
      { signal }
    )
  )

export const runQuery = async (
  sourceId: string,
  sql: string,
  signal?: AbortSignal
): Promise<QueryResult> =>
  toResult(
    await request<QueryResponse>(`${sourceUrl(sourceId)}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
      signal,
    })
  )
