// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import { DatabaseBrowser } from './DatabaseBrowser'

const SCHEMA = {
  source_id: 'market_analysis_structured',
  database_name: 'market_analysis',
  tables: [
    {
      name: 'assets',
      description: 'Listed companies',
      columns: [{ name: 'asset_id', type: 'VARCHAR' }],
    },
    { name: 'daily_prices', columns: [{ name: 'asset_id', type: 'VARCHAR' }] },
  ],
  relationships: [
    {
      from_table: 'daily_prices',
      from_column: 'asset_id',
      to_table: 'assets',
      to_column: 'asset_id',
    },
  ],
}
const rows = (value: string) => ({
  columns: ['asset_id'],
  rows: [[value]],
  truncated: false,
  duration_ms: 3,
})

const ONTOLOGY = {
  truncated: false,
  nodes: [
    { id: 'table:1', kind: 'table', label: 'assets' },
    { id: 'column:1', kind: 'column', label: 'asset_id' },
    { id: 'term:1', kind: 'term', label: 'Company' },
  ],
  edges: [
    { kind: 'contains', source: 'table:1', target: 'column:1' },
    { kind: 'represents', source: 'term:1', target: 'table:1' },
  ],
}

/**
 * The API's data viewer routes; a query that is not a SELECT is refused.
 * The ontology is 404 unless Auto Ontology runs.
 */
const serveApi = (ontology: object | null = null) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/schema')) return Response.json(SCHEMA)
    if (url.endsWith('/ontology')) {
      return ontology ? Response.json(ontology) : Response.json({}, { status: 404 })
    }
    if (url.includes('/preview?table=assets')) return Response.json(rows('asset-delta'))
    const { sql } = JSON.parse(String(init?.body))
    return sql.startsWith('SELECT')
      ? Response.json(rows('asset-kestrel'))
      : Response.json({ detail: 'Only read-only queries are allowed.' }, { status: 400 })
  })

const Browser = () => {
  const [sql, setSql] = useState('SELECT asset_id FROM assets')
  return (
    <DatabaseBrowser sourceIds={['market_analysis_structured']} sql={sql} onSqlChange={setSql} />
  )
}

describe('DatabaseBrowser', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows the tables, a preview of the first one, and runs a query', async () => {
    const fetchMock = serveApi()
    render(<Browser />)

    expect(await screen.findByText('Tables in market_analysis')).toBeVisible()
    expect(await screen.findByRole('region', { name: 'Preview of assets' })).toHaveTextContent(
      'asset-delta'
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/data_sources/market_analysis_structured/preview?table=assets&limit=20',
      expect.anything()
    )

    await userEvent.click(screen.getByRole('button', { name: 'Run query' }))
    expect(
      within(await screen.findByRole('region', { name: 'Query result' })).getByText('asset-kestrel')
    ).toBeVisible()
  })

  it('shows the API’s reason when a query is refused', async () => {
    serveApi()
    render(<Browser />)
    const editor = screen.getByRole('textbox', { name: 'SQL query' })
    await userEvent.clear(editor)
    await userEvent.type(editor, 'DROP TABLE assets')
    await userEvent.click(screen.getByRole('button', { name: 'Run query' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only read-only queries are allowed.'
    )
  })

  it('draws the ontology objects and the tables they represent when Auto Ontology runs', async () => {
    serveApi(ONTOLOGY)
    render(<Browser />)
    expect(await screen.findByRole('figure', { name: 'Ontology objects' })).toBeVisible()
    expect(screen.getByRole('group', { name: 'Company' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'asset_id' })).toBeNull()
  })

  it('hides the ontology, without an error, when the API has none', async () => {
    serveApi()
    render(<Browser />)
    // The preview needs two requests in a row; the ontology request has answered by then
    expect(await screen.findByRole('region', { name: 'Preview of assets' })).toBeVisible()
    expect(screen.queryByText('Ontology')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says when the run used no structured source', () => {
    render(<DatabaseBrowser sourceIds={[]} sql="" onSqlChange={vi.fn()} />)
    expect(screen.getByText('This run used no structured data source.')).toBeVisible()
  })
})
