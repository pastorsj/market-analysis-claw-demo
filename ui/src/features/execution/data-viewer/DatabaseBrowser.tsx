// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browse the structured data behind a run (live mode): tables and their
 * relationships, a preview of each table, the ontology objects over the
 * tables (when Auto Ontology runs), and read-only SQL, e.g. a receipt's query
 * opened from its explorer.
 */

'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Flex, SegmentedControl, Table, Tag, Text, TextArea } from '@/adapters/ui'
import { cellText, formatDuration, plural } from '../format'
import { FlowCanvas, type CanvasItem } from '../graph'
import {
  getOntology,
  getPreview,
  getSchema,
  runQuery,
  type DatabaseSchema,
  type OntologySnapshot,
  type QueryResult,
} from './database-client'

interface DatabaseBrowserProps {
  /** Structured data sources to browse; the first is selected */
  sourceIds: string[]
  sql: string
  onSqlChange: (sql: string) => void
}

const TABLE_NODE = { width: 180, height: 44 }

const ResultTable = ({ result, label }: { result: QueryResult; label: string }): ReactNode => (
  <div className="overflow-x-auto" aria-label={label} role="region">
    <Table
      density="compact"
      columns={result.columns}
      rows={result.rows.map((row, index) => ({ id: String(index), cells: row.map(cellText) }))}
    />
    <Text kind="body/regular/xs" className="text-secondary">
      {plural(result.rows.length, 'row')} · {formatDuration(result.duration_ms)}
      {result.truncated ? ' · more rows were cut' : ''}
    </Text>
  </div>
)

/** Tables joined by foreign keys, as a graph. */
const relationshipGraph = (schema: DatabaseSchema) => {
  const edges = schema.relationships.map((r) => ({ source: r.from_table, target: r.to_table }))
  const names = [...new Set(edges.flatMap((edge) => [edge.source, edge.target]))]
  const nodes: CanvasItem[] = names.map((name) => ({ id: name, label: name, kind: 'table' }))
  return { nodes, edges }
}

/** Ontology objects and the tables they represent, as a graph. */
const ontologyGraph = (snapshot: OntologySnapshot) => {
  const edges = snapshot.edges
    .filter((edge) => edge.kind === 'represents')
    .map(({ source, target }) => ({ source, target }))
  const linked = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
  const nodes: CanvasItem[] = snapshot.nodes
    .filter((node) => linked.has(node.id))
    .map(({ id, label, kind }) => ({ id, label, kind }))
  return { nodes, edges }
}

export const DatabaseBrowser = ({
  sourceIds,
  sql,
  onSqlChange,
}: DatabaseBrowserProps): ReactNode => {
  const [chosenSource, setChosenSource] = useState<string | null>(null)
  const sourceId =
    chosenSource && sourceIds.includes(chosenSource) ? chosenSource : (sourceIds[0] ?? null)
  const [schema, setSchema] = useState<DatabaseSchema | null>(null)
  const [tableName, setTableName] = useState<string | null>(null)
  const [preview, setPreview] = useState<QueryResult | null>(null)
  const [ontology, setOntology] = useState<OntologySnapshot | null>(null)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!sourceId) return
    const controller = new AbortController()
    setSchema(null)
    setTableName(null)
    setError(null)
    getSchema(sourceId, controller.signal)
      .then((loaded) => {
        setSchema(loaded)
        setTableName(loaded.tables[0]?.name ?? null)
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message)
      })
    return () => controller.abort()
  }, [sourceId])

  useEffect(() => {
    if (!sourceId) return
    const controller = new AbortController()
    setOntology(null)
    getOntology(sourceId, controller.signal)
      .then(setOntology)
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message)
      })
    return () => controller.abort()
  }, [sourceId])

  useEffect(() => {
    if (!sourceId || !tableName) return
    const controller = new AbortController()
    setPreview(null)
    getPreview(sourceId, tableName, controller.signal)
      .then(setPreview)
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message)
      })
    return () => controller.abort()
  }, [sourceId, tableName])

  const graph = useMemo(() => (schema ? relationshipGraph(schema) : null), [schema])
  const objects = useMemo(() => (ontology ? ontologyGraph(ontology) : null), [ontology])
  const table = schema?.tables.find((candidate) => candidate.name === tableName) ?? null

  const run = async () => {
    if (!sourceId) return
    setRunning(true)
    setError(null)
    try {
      setResult(await runQuery(sourceId, sql))
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setRunning(false)
    }
  }

  if (!sourceId) {
    return <Text kind="body/regular/sm">This run used no structured data source.</Text>
  }

  return (
    <Flex direction="col" gap="4" className="p-4">
      {sourceIds.length > 1 && (
        <SegmentedControl
          size="small"
          value={sourceId}
          onValueChange={setChosenSource}
          items={sourceIds}
        />
      )}
      {error && (
        <Text kind="body/regular/sm" className="text-feedback-danger" role="alert">
          {error}
        </Text>
      )}
      {!schema && !error && <Text kind="body/regular/sm">Loading the schema…</Text>}

      {schema && (
        <>
          <Text kind="label/semibold/md">Tables in {schema.database_name}</Text>
          <Flex gap="2" className="flex-wrap">
            {schema.tables.map(({ name }) => (
              <Tag
                key={name}
                kind="outline"
                selected={name === tableName}
                onClick={() => setTableName(name)}
              >
                {name}
              </Tag>
            ))}
          </Flex>
          {table && (
            <>
              {table.description && <Text kind="body/regular/sm">{table.description}</Text>}
              <Table
                density="compact"
                columns={['Column', 'Type', 'Description']}
                rows={table.columns.map((column) => ({
                  id: column.name,
                  cells: [column.name, column.type, column.description ?? ''],
                }))}
              />
              {preview && <ResultTable result={preview} label={`Preview of ${table.name}`} />}
            </>
          )}
          {graph && graph.nodes.length > 0 && (
            <FlowCanvas
              nodes={graph.nodes}
              edges={graph.edges}
              nodeSize={TABLE_NODE}
              height={280}
              ariaLabel="Table relationships"
            />
          )}
        </>
      )}

      {objects && objects.nodes.length > 0 && (
        <>
          <Text kind="label/semibold/md">Ontology</Text>
          <Text kind="body/regular/sm" className="text-secondary">
            The objects Auto Ontology found and the tables they represent
            {ontology?.truncated ? ' (a large ontology is cut short)' : ''}.
          </Text>
          <FlowCanvas
            nodes={objects.nodes}
            edges={objects.edges}
            nodeSize={TABLE_NODE}
            height={320}
            ariaLabel="Ontology objects"
          />
        </>
      )}

      <Text kind="label/semibold/md">Query</Text>
      <TextArea
        value={sql}
        onValueChange={onSqlChange}
        placeholder={`SELECT * FROM ${tableName ?? '<table>'} LIMIT 10`}
        resizeable="auto"
        aria-label="SQL query"
      />
      <Button kind="primary" size="small" disabled={running || !sql.trim()} onClick={run}>
        {running ? 'Running…' : 'Run query'}
      </Button>
      {result && <ResultTable result={result} label="Query result" />}
    </Flex>
  )
}
