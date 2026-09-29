// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The evidence behind one graph node: its tool calls, and for the chosen call
 * the receipt rendered as sections (facts, SQL/PQL, tables, charts, passages,
 * lineage graph).
 */

'use client'

import { useState, type ReactNode } from 'react'
import { Anchor, Button, CodeSnippet, Flex, SegmentedControl, Table, Text } from '@/adapters/ui'
import { Close, OpenExternal } from '@/adapters/ui/icons'
import { normalizeChart, ResultChart } from '@/shared/components/ResultChart'
import type { ReceiptV2 } from '../contract'
import { cellText } from '../format'
import { FlowCanvas } from '../graph'
import type { ToolCall } from '../projection'
import { phoenixSpanUrl } from '../trace-link'
import { explorerSections, type EvidenceSection } from './index'

export interface CapabilityExplorerProps {
  title: string
  description: string | null
  calls: ToolCall[]
  receipts: Record<string, ReceiptV2>
  /** Receipt to show first, e.g. the evidence a citation points at */
  focusReceiptId?: string | null
  /** Browser-reachable Phoenix; links each receipt's span when set */
  phoenixUrl?: string | null
  /** Opens a receipt's SQL in the data viewer (live mode) */
  onOpenQuery?: (sql: string) => void
  onClose: () => void
}

const LINEAGE_NODE = { width: 190, height: 52 }

const SectionView = ({
  section,
  onOpenQuery,
}: {
  section: EvidenceSection
  onOpenQuery?: (sql: string) => void
}): ReactNode => {
  switch (section.kind) {
    case 'facts':
      return (
        <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {section.facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-secondary">{fact.label}</dt>
              <dd className="[overflow-wrap:anywhere]">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )
    case 'code':
      return (
        <Flex direction="col" gap="2">
          {/* KUI's highlighter has no SQL grammar; plain shell styling, as upstream's fallback */}
          <CodeSnippet value={section.code} language="shell" kind="block" />
          {section.language === 'sql' && onOpenQuery && (
            <Button kind="tertiary" size="small" onClick={() => onOpenQuery(section.code)}>
              Open in data viewer
            </Button>
          )}
        </Flex>
      )
    case 'table':
      return (
        <div className="overflow-x-auto">
          <Table
            density="compact"
            columns={section.columns}
            rows={section.rows.map((row, index) => ({
              id: String(index),
              cells: row.map(cellText),
            }))}
          />
          {section.note && <Text kind="body/regular/xs">{section.note}</Text>}
        </div>
      )
    case 'chart': {
      const { spec, truncation } = normalizeChart(section.spec)
      return <ResultChart spec={spec} truncation={truncation} />
    }
    case 'passages':
      return (
        <ol className="flex flex-col gap-3">
          {section.passages.map((passage) => (
            <li key={passage.id} className="border-base rounded-md border p-3">
              <Text kind="label/semibold/sm">{passage.title}</Text>
              <Text kind="body/regular/xs" className="text-secondary block">
                {passage.source} · {passage.score}
              </Text>
              <p className="mt-2 whitespace-pre-line text-sm [overflow-wrap:anywhere]">
                {passage.text}
              </p>
              {passage.citation && (
                <p className="text-secondary mt-1 text-xs">{passage.citation}</p>
              )}
              {passage.url && (
                <Anchor href={passage.url} target="_blank" rel="noreferrer" className="text-xs">
                  Source document
                </Anchor>
              )}
            </li>
          ))}
        </ol>
      )
    case 'graph':
      return (
        <FlowCanvas
          nodes={section.nodes}
          edges={section.edges}
          nodeSize={LINEAGE_NODE}
          height={260}
          ariaLabel={section.title}
        />
      )
    case 'notes':
      return (
        <ul className="list-disc pl-5 text-sm">
          {section.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )
  }
}

/** Why there is no receipt to show yet. */
const waitingFor = (calls: ToolCall[]): string => {
  if (calls.some((call) => call.state === 'running')) {
    return 'The tool is still running; its evidence appears when it finishes.'
  }
  if (calls.some((call) => call.receiptIds.length > 0)) return 'Loading the evidence…'
  return calls.length ? 'No evidence was recorded for this step.' : 'This step has not run yet.'
}

export const CapabilityExplorer = ({
  title,
  description,
  calls,
  receipts,
  focusReceiptId = null,
  phoenixUrl = null,
  onOpenQuery,
  onClose,
}: CapabilityExplorerProps): ReactNode => {
  const available = calls.flatMap((call) => call.receiptIds.flatMap((id) => receipts[id] ?? []))
  const [chosenId, setChosenId] = useState<string | null>(focusReceiptId)
  const receipt =
    available.find((candidate) => candidate.receiptId === chosenId) ?? available.at(-1) ?? null
  const shown = receipt ? explorerSections(receipt) : []
  const spanUrl = receipt && phoenixUrl ? phoenixSpanUrl(phoenixUrl, receipt.spanId) : null

  return (
    <section
      aria-label={`${title} explorer`}
      className="flex h-full flex-col gap-4 overflow-y-auto p-4"
    >
      <Flex justify="between" align="start" gap="2">
        <div>
          <Text kind="title/lg">{title}</Text>
          {description && (
            <Text kind="body/regular/sm" className="text-secondary block">
              {description}
            </Text>
          )}
        </div>
        <Button kind="tertiary" size="small" onClick={onClose} aria-label="Close explorer">
          <Close className="h-4 w-4" />
        </Button>
      </Flex>

      {available.length > 1 && (
        <SegmentedControl
          size="small"
          value={receipt?.receiptId}
          onValueChange={setChosenId}
          items={available.map((candidate, index) => ({
            value: candidate.receiptId,
            children: `Call ${index + 1}`,
          }))}
        />
      )}

      {!receipt && <Text kind="body/regular/sm">{waitingFor(calls)}</Text>}

      {shown.map((section, index) => (
        <section
          key={`${section.kind}-${index}`}
          aria-label={section.title}
          className="flex min-w-0 flex-col gap-2"
        >
          <Text kind="label/semibold/md">{section.title}</Text>
          <SectionView section={section} onOpenQuery={onOpenQuery} />
        </section>
      ))}

      {spanUrl && (
        <Anchor href={spanUrl} target="_blank" rel="noreferrer" className="text-sm">
          <Flex align="center" gap="1">
            Open this call in Phoenix <OpenExternal className="h-3 w-3" />
          </Flex>
        </Anchor>
      )}
    </section>
  )
}
