// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The execution view of one run: replay controls over its events, then the
 * graph (with the explorer of the selected node), the timeline, or the data
 * viewer. Live runs load their receipts from the job export; recorded runs
 * are already in the store.
 */

'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Anchor, Button, Flex, Table, Tabs, Text } from '@/adapters/ui'
import { Close, OpenExternal } from '@/adapters/ui/icons'
import { useLayoutStore } from '@/features/layout/store'
import { useAppConfig, type ExecutionFocus, type ExecutionWorkspaceProps } from '@/shared/context'
import type { ExecutionEventV2, ReceiptV2 } from './contract'
import { DatabaseBrowser } from './data-viewer/DatabaseBrowser'
import { CapabilityExplorer } from './explorers/CapabilityExplorer'
import { formatCount, shortModel } from './format'
import { buildExecutionGraph, FlowCanvas, type GraphNode } from './graph'
import { describeRun, projectRun, runEnded, type RunProjection, type ToolCall } from './projection'
import { ReplayControls } from './replay/ReplayControls'
import { loadJobExport } from './replay/sources'
import { useReplay } from './replay/use-replay'
import { useExecutionRun } from './store'
import { ExecutionTimeline } from './timeline/ExecutionTimeline'
import { buildTimeline } from './timeline/timeline-model'
import { useTraceUrl } from './trace-link'

type Tab = 'graph' | 'timeline' | 'data'
type ExportState = 'loading' | 'loaded' | 'failed'

const NO_EVENTS: ExecutionEventV2[] = []
const NO_RECEIPTS: Record<string, ReceiptV2> = {}
const GRAPH_NODE = { width: 200, height: 90 }
const SANDBOX = { nodeId: 'agent', label: 'OpenShell sandbox' }

/**
 * Live mode: the job export holds the receipts (and the events of a run that
 * streamed before this page loaded). Fetch it on open, when the run reports
 * new evidence and when it finishes.
 */
const useJobExport = (jobId: string, live: boolean, run: RunProjection): ExportState => {
  const [state, setState] = useState<ExportState>('loading')
  const evidence = run.toolCalls.reduce((count, call) => count + call.receiptIds.length, 0)
  const finished = run.status !== 'running'
  useEffect(() => {
    if (!live) return
    let cancelled = false
    loadJobExport(jobId).then(
      () => {
        if (!cancelled) setState('loaded')
      },
      () => {
        if (!cancelled) setState('failed')
      }
    )
    return () => {
      cancelled = true
    }
  }, [jobId, live, evidence, finished])
  return live ? state : 'loaded'
}

/** The tool call a citation points at: by invocation id, else by evidence (receipt) id. */
const focusedCall = (run: RunProjection, focus: ExecutionFocus | null): ToolCall | undefined =>
  focus
    ? run.toolCalls.find(
        (call) =>
          call.invocationId === focus.invocationId ||
          (focus.referenceId !== undefined && call.receiptIds.includes(focus.referenceId))
      )
    : undefined

/** Structured sources seen in the run's receipts, plus the pack's structured sources. */
const useStructuredSources = (receipts: Record<string, ReceiptV2>): string[] => {
  const available = useLayoutStore((state) => state.availableDataSources)
  return useMemo(() => {
    const fromReceipts = Object.values(receipts).flatMap((receipt) =>
      receipt.artifactKind === 'analytics_result' && receipt.content
        ? [receipt.content.sourceId]
        : []
    )
    // The API passes each source's pack `kind` through; DataSourceFromAPI does not type it.
    const fromPack = (available ?? [])
      .filter((source) => 'kind' in source && source.kind === 'structured')
      .map((source) => source.id)
    return [...new Set([...fromReceipts, ...fromPack])]
  }, [receipts, available])
}

const ModelCalls = ({ run, onClose }: { run: RunProjection; onClose: () => void }): ReactNode => (
  <section aria-label="Model calls" className="flex h-full flex-col gap-3 overflow-y-auto p-4">
    <Flex justify="between" align="center">
      <Text kind="title/lg">Switchyard router</Text>
      <Button kind="tertiary" size="small" onClick={onClose} aria-label="Close explorer">
        <Close className="h-4 w-4" />
      </Button>
    </Flex>
    <Text kind="body/regular/sm" className="text-secondary">
      Each model call and the model Switchyard served for it.
    </Text>
    <div className="overflow-x-auto">
      <Table
        density="compact"
        columns={['Served model', 'Tier', 'Tokens in / out']}
        rows={run.modelCalls.map((call) => ({
          id: call.invocationId,
          cells: [
            call.servedModel ? shortModel(call.servedModel) : '–',
            call.tier ?? '–',
            `${formatCount(call.inputTokens)} / ${formatCount(call.outputTokens)}`,
          ],
        }))}
      />
    </div>
  </section>
)

export const ExecutionWorkspace = ({
  jobId,
  focus,
  onClose,
}: ExecutionWorkspaceProps): ReactNode => {
  const { mode, phoenixUrl } = useAppConfig()
  const live = mode === 'live'
  const stored = useExecutionRun(jobId)
  const events = stored?.events ?? NO_EVENTS
  const receipts = stored?.receipts ?? NO_RECEIPTS
  const jobStatus = stored?.jobStatus ?? null

  const whole = useMemo(() => projectRun(events, jobStatus), [events, jobStatus])
  const exportState = useJobExport(jobId, live, whole)
  const replay = useReplay(events.length)
  const shownEvents = useMemo(() => events.slice(0, replay.step), [events, replay.step])
  // The job's status only describes the whole run, not a replay prefix
  const atEnd = replay.step === replay.total
  const shown = useMemo(
    () => projectRun(shownEvents, atEnd ? jobStatus : null),
    [shownEvents, atEnd, jobStatus]
  )
  const graph = useMemo(() => buildExecutionGraph(shown, whole, receipts), [shown, whole, receipts])
  const timeline = useMemo(() => buildTimeline(shownEvents, shown), [shownEvents, shown])
  const traceUrl = useTraceUrl(jobId, live ? phoenixUrl : null, runEnded(whole.status))
  const structuredSources = useStructuredSources(receipts)

  const [tab, setTab] = useState<Tab>('graph')
  const [sql, setSql] = useState('')
  // undefined: nothing chosen yet, so a cited call (focus) is selected
  const [chosenNode, setChosenNode] = useState<string | null>()
  const focusCall = focusedCall(whole, focus)
  const selectedId =
    chosenNode === undefined && focusCall ? `tool:${focusCall.name}` : (chosenNode ?? null)
  const selected: GraphNode | undefined = graph.nodes.find((node) => node.id === selectedId)
  const calls = shown.toolCalls.filter((call) =>
    selected?.invocationIds.includes(call.invocationId)
  )

  const selectCall = (invocationId: string) => {
    const call = whole.toolCalls.find((candidate) => candidate.invocationId === invocationId)
    if (call) setChosenNode(`tool:${call.name}`)
    setTab('graph')
  }
  const openQuery = (query: string) => {
    setSql(query)
    setTab('data')
  }

  const tabs = [
    { value: 'graph', children: 'Graph' },
    { value: 'timeline', children: 'Timeline' },
    ...(live ? [{ value: 'data', children: 'Data' }] : []),
  ]
  const currentEvent = shownEvents.at(-1)

  let panel: ReactNode = null
  if (selected?.kind === 'router') {
    panel = <ModelCalls run={shown} onClose={() => setChosenNode(null)} />
  } else if (selected?.kind === 'tool' || selected?.kind === 'resource') {
    panel = (
      <CapabilityExplorer
        key={selected.id}
        title={selected.label}
        description={selected.description}
        calls={calls}
        receipts={receipts}
        focusReceiptId={focus?.referenceId ?? null}
        phoenixUrl={live ? phoenixUrl : null}
        onOpenQuery={live ? openQuery : undefined}
        onClose={() => setChosenNode(null)}
      />
    )
  }

  return (
    <section
      aria-label="Execution workspace"
      className="flex h-full flex-col gap-3 overflow-hidden py-3"
    >
      <Flex justify="between" align="center" gap="3" className="px-4">
        <div className="min-w-0">
          <Text kind="title/lg">Execution</Text>
          <Text kind="body/regular/xs" className="text-secondary block truncate">
            {describeRun(shown)} · <code>{jobId}</code>
          </Text>
        </div>
        <Flex align="center" gap="3">
          {traceUrl && (
            <Anchor href={traceUrl} target="_blank" rel="noreferrer" className="text-sm">
              <Flex align="center" gap="1">
                Trace in Phoenix <OpenExternal className="h-3 w-3" />
              </Flex>
            </Anchor>
          )}
          <Button
            kind="secondary"
            size="small"
            onClick={onClose}
            aria-label="Close the execution view"
          >
            Close
          </Button>
        </Flex>
      </Flex>

      {events.length === 0 ? (
        <Text kind="body/regular/sm" className="px-4">
          {exportState === 'loading'
            ? 'Loading the run…'
            : 'No execution record is available for this answer.'}
        </Text>
      ) : (
        <>
          <div className="px-4">
            <Tabs items={tabs} value={tab} onValueChange={(value) => setTab(value as Tab)} />
          </div>
          {tab !== 'data' && (
            <div className="px-4">
              <ReplayControls replay={replay} currentLabel={currentEvent?.display.label ?? null} />
            </div>
          )}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {tab === 'graph' && (
              <>
                <div className="min-w-0 flex-1 px-4 pb-1">
                  <FlowCanvas
                    nodes={graph.nodes}
                    edges={graph.edges}
                    nodeSize={GRAPH_NODE}
                    height="100%"
                    ariaLabel="Execution graph"
                    selectedId={selectedId}
                    onSelect={setChosenNode}
                    group={SANDBOX}
                  />
                </div>
                {panel && (
                  <aside className="border-base w-[40%] min-w-[24rem] border-l">{panel}</aside>
                )}
              </>
            )}
            {tab === 'timeline' && (
              <div className="flex-1 overflow-y-auto px-4">
                <ExecutionTimeline timeline={timeline} onSelectCall={selectCall} />
              </div>
            )}
            {tab === 'data' && (
              <div className="flex-1 overflow-y-auto">
                <DatabaseBrowser sourceIds={structuredSources} sql={sql} onSqlChange={setSql} />
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
