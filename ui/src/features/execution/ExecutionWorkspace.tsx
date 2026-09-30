// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The execution view of one run: its header, replay controls over its
 * events, the run summary once it ends, and the execution graph. Choosing a
 * node opens its explorer over the graph; the structured database opens the
 * data viewer in live mode. Live runs load their receipts from the job
 * export; recorded runs are already in the store.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAppConfig, type ExecutionFocus, type ExecutionWorkspaceProps } from '@/shared/context'
import type { ExecutionEventV2, ReceiptV2 } from './contract'
import { DatabaseBrowser } from './data-viewer/DatabaseBrowser'
import styles from './execution-workspace.module.css'
import { CapabilityExplorer } from './explorers/CapabilityExplorer'
import { elapsedMs } from './format'
import {
  buildExecutionGraphViewModel,
  buildExecutionNodeDetail,
  buildGpuAccelerationByNode,
  ExecutionGraph,
  isInspectableExecutionNodeState,
  isInspectableNode,
  nodeIdsForEvent,
  TOOL_NODE_BY_NAME,
  toGraphEvent,
  toGraphProjection,
  type ExecutionNodeDetail,
  type GraphComponent,
  type InspectableExecutionNodeId,
} from './graph'
import { projectRun, runEnded, type RunProjection, type ToolCall } from './projection'
import { TOOL_LOGOS, toolFor, type NodeLogo } from './registry'
import { ReplayControls } from './replay/ReplayControls'
import { loadJobExport } from './replay/sources'
import { useReplay } from './replay/use-replay'
import { useExecutionRun } from './store'

type ExportState = 'loading' | 'loaded' | 'failed'
type ReplayScopeState = 'future' | 'between' | 'past'

const NO_EVENTS: ExecutionEventV2[] = []
const NO_RECEIPTS: Record<string, ReceiptV2> = {}
/** Every data pack's structured source is a DuckDB database. */
const DUCKDB_MARK = { src: '/capability-assets/provider-duckdb.svg', alt: 'DuckDB' }

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

/** The first inspectable node a tool call lights, to open it from a citation. */
const nodeOfCall = (
  call: ToolCall,
  events: readonly ExecutionEventV2[]
): InspectableExecutionNodeId | null =>
  events
    .filter((event) => event.invocationId === call.invocationId)
    .flatMap((event) => nodeIdsForEvent(toGraphEvent(event)))
    .find((nodeId): nodeId is InspectableExecutionNodeId => isInspectableNode(nodeId)) ?? null

/** Structured sources the run's receipts name. */
const structuredSourcesOf = (receipts: Record<string, ReceiptV2>): string[] => [
  ...new Set(
    Object.values(receipts).flatMap((receipt) =>
      receipt.artifactKind === 'analytics_result' && receipt.content
        ? [receipt.content.sourceId]
        : []
    )
  ),
]

/** The logos of each node whose tool is built on a library, from the registry. */
const NODE_LOGOS: ReadonlyMap<string, readonly NodeLogo[]> = new Map(
  Object.entries(TOOL_LOGOS).flatMap(([toolId, logos]) => {
    const nodeId = TOOL_NODE_BY_NAME[toolId]
    return nodeId && logos ? [[nodeId, logos] as const] : []
  })
)

const STEP_TOOL_LABELS: Readonly<Record<string, string>> = {
  tool_search: 'Tool Search',
  tool_describe: 'Tool Describe',
  tool_call: 'Tool Call',
  skills_list: 'Skills List',
  skill_view: 'Skill View',
  ask_question: 'Auto Ontology query',
  retrieve_evidence: 'Unstructured Retrieval',
}

const RESULT_LABELS: Readonly<Partial<Record<GraphComponent, string>>> = {
  structured_retrieval: 'Structured result available',
  structured_prediction: 'Prediction result available',
  unstructured_retrieval: 'Retrieved evidence available',
  market_analytics: 'Market analytics result available',
}

/** What the event at the replay cursor did, in the words of the replay bar. */
const stepLabel = (event: ExecutionEventV2 | undefined): string | undefined => {
  if (!event) return undefined
  switch (event.eventKind) {
    case 'run.created':
      return 'Hermes Agent started'
    case 'reasoning.available':
      return 'Evaluating results'
    case 'run.heartbeat':
      return 'Hermes Agent working'
    case 'run.completed':
      return 'Answer complete'
    case 'run.failed':
      return 'Run failed'
  }
  const graphEvent = toGraphEvent(event)
  if (graphEvent.kind === 'artifact.available') {
    return RESULT_LABELS[graphEvent.component] ?? event.display.label
  }
  if (!graphEvent.kind.startsWith('invocation.') || !graphEvent.toolName) {
    return event.display.label
  }
  const label =
    STEP_TOOL_LABELS[graphEvent.toolName] ?? toolFor(event.toolName)?.label ?? graphEvent.toolName
  return `${label} ${graphEvent.kind.slice('invocation.'.length)}`
}

const LIVE_OWNERS: Readonly<Record<GraphComponent, string>> = {
  agent: 'Hermes Agent',
  tool: 'Tool',
  ontology: 'Ontology Grounding',
  structured_retrieval: 'Structured Retrieval',
  structured_prediction: 'Structured Prediction',
  unstructured_retrieval: 'Unstructured Retrieval',
  market_analytics: 'Market Analytics',
}

const liveActivityDescription = (call: ToolCall | undefined): string => {
  if (!call) return 'Planning, invoking tools, or synthesizing the response'
  if (call.tool?.id === 'retrieve_evidence') {
    return 'Retrieving evidence with Milvus and NVIDIA Nemotron'
  }
  if (call.tool?.id === 'ask_question') return 'Generating and executing SQL with Auto Ontology'
  return `${call.label} is running`
}

const formatElapsed = (elapsedSeconds: number): string => {
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  return minutes ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

const formatDurationMs = (durationMs: number | null): string => {
  if (durationMs === null) return 'Duration unavailable'
  if (durationMs < 1_000) return `${durationMs} ms`
  const seconds = durationMs / 1_000
  return seconds < 60
    ? `${seconds.toFixed(Number.isInteger(seconds) ? 0 : 1)} s`
    : formatElapsed(Math.round(seconds))
}

const formatMetricCount = (count: number | null): string =>
  count === null ? 'Unavailable' : new Intl.NumberFormat('en-US').format(count)

/** Publication, runtime and token usage of a run that has ended. */
const RunSummary = ({
  run,
  citedEvidenceIds,
}: {
  run: RunProjection
  citedEvidenceIds: string[] | null
}): ReactNode => {
  const cited = new Set(citedEvidenceIds ?? [])
  const uncited = new Set(
    run.toolCalls.flatMap((call) => call.receiptIds).filter((id) => !cited.has(id))
  ).size
  const wallMs =
    run.startedAt && run.endedAt
      ? Math.max(0, Math.round(elapsedMs(run.startedAt, run.endedAt)))
      : null
  const toolMs = run.toolCalls.reduce(
    (total, call) =>
      total + (call.endedAt ? Math.max(0, elapsedMs(call.startedAt, call.endedAt)) : 0),
    0
  )
  const tokens = run.inputTokens + run.outputTokens

  return (
    <section className={styles.runSummary} aria-label="Hermes run summary">
      <div>
        <small>Publication</small>
        <strong>{cited.size ? 'Citation/reference IDs resolved' : 'Answer published'}</strong>
        <span>
          {cited.size} cited evidence item(s)
          {uncited ? ` · ${uncited} available but uncited` : ''}
        </span>
      </div>
      <div>
        <small>Runtime</small>
        <strong>{formatDurationMs(wallMs)}</strong>
        <span>
          {run.toolCalls.length} tool call(s) · {formatDurationMs(Math.round(toolMs))} observed tool
          time
        </span>
      </div>
      <div>
        <small>Token Usage</small>
        <strong>{formatMetricCount(tokens || null)} tokens</strong>
        <span>
          {formatMetricCount(run.inputTokens)} input · {formatMetricCount(run.outputTokens)} output
        </span>
      </div>
    </section>
  )
}

/** Shown instead of an explorer while replay is at a step where the chosen node is not active. */
const ReplayScopedInspectorNotice = ({
  detail,
  currentStep,
  currentLabel,
  scopeState,
  onClose,
}: {
  detail: ExecutionNodeDetail
  currentStep: number
  currentLabel?: string
  scopeState: ReplayScopeState
  onClose: () => void
}): ReactNode => {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const title =
    scopeState === 'future'
      ? `${detail.label} has not been reached yet`
      : scopeState === 'between'
        ? `${detail.label} is between observed calls`
        : `${detail.label} is not active at this replay step`
  const guidance =
    scopeState === 'future'
      ? `Move forward to a step where ${detail.label} is active to inspect its evidence.`
      : `Move to a step where ${detail.label} is active, or finish the replay, to inspect its evidence.`

  return (
    <section
      className={styles.capabilityExplorer}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      data-testid="capability-explorer"
      data-presentation="replay-scope-notice"
      data-capability={detail.id}
      aria-label={`${detail.label} replay status`}
    >
      <header className={styles.capabilityExplorerHeader}>
        <div>
          <span className={styles.eyebrow}>Replay-scoped evidence</span>
          <h3>{detail.label}</h3>
          <p>Inspector evidence follows the active replay step.</p>
        </div>
        <div className={styles.capabilityExplorerHeaderActions}>
          <span className={styles.capabilityCursor}>Replay step {currentStep}</span>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label={`Close ${detail.label} replay status`}
          >
            ×
          </button>
        </div>
      </header>
      <div
        className={styles.replayScopeNotice}
        data-testid="replay-scope-notice"
        aria-live="polite"
      >
        <span className={styles.replayScopeNoticeIcon} aria-hidden="true">
          ↔
        </span>
        <div>
          <small>Step {currentStep || 0}</small>
          <h4>{title}</h4>
          {currentLabel ? <p>This step is showing {currentLabel}.</p> : null}
          <p>{guidance}</p>
        </div>
      </div>
    </section>
  )
}

export const ExecutionWorkspace = ({
  jobId,
  focus,
  onClose,
}: ExecutionWorkspaceProps): ReactNode => {
  const { mode, phoenixUrl } = useAppConfig()
  const liveMode = mode === 'live'
  const stored = useExecutionRun(jobId)
  const events = stored?.events ?? NO_EVENTS
  const receipts = stored?.receipts ?? NO_RECEIPTS
  const jobStatus = stored?.jobStatus ?? null

  const whole = useMemo(() => projectRun(events, jobStatus), [events, jobStatus])
  const exportState = useJobExport(jobId, liveMode, whole)
  const replay = useReplay(events.length)
  const shownEvents = useMemo(() => events.slice(0, replay.step), [events, replay.step])
  // The job's status only describes the whole run, not a replay prefix
  const atEnd = replay.step === replay.total
  const shown = useMemo(
    () => projectRun(shownEvents, atEnd ? jobStatus : null),
    [shownEvents, atEnd, jobStatus]
  )

  const allGraphEvents = useMemo(() => events.map(toGraphEvent), [events])
  const shownGraphEvents = useMemo(
    () => allGraphEvents.slice(0, replay.step),
    [allGraphEvents, replay.step]
  )
  const shownProjection = useMemo(
    () => toGraphProjection(shown, shownGraphEvents),
    [shown, shownGraphEvents]
  )
  const wholeProjection = useMemo(
    () => toGraphProjection(whole, allGraphEvents),
    [whole, allGraphEvents]
  )
  const graph = useMemo(
    () =>
      buildExecutionGraphViewModel({
        allEvents: allGraphEvents,
        visibleEvents: shownGraphEvents,
        projection: shownProjection,
      }),
    [allGraphEvents, shownGraphEvents, shownProjection]
  )
  const fullGraph = useMemo(
    () =>
      buildExecutionGraphViewModel({
        allEvents: allGraphEvents,
        visibleEvents: allGraphEvents,
        projection: wholeProjection,
      }),
    [allGraphEvents, wholeProjection]
  )
  const gpuAccelerations = useMemo(
    () =>
      buildGpuAccelerationByNode(
        shown.toolCalls.flatMap((call) => call.receiptIds.flatMap((id) => receipts[id] ?? []))
      ),
    [shown, receipts]
  )
  const structuredSources = useMemo(() => structuredSourcesOf(receipts), [receipts])

  const currentEvent = shownEvents.at(-1)
  const currentGraphEvent = shownGraphEvents.at(-1)
  const terminalInspection = atEnd && runEnded(shown.status)
  const currentInspectableNodeIds = useMemo(
    () =>
      new Set<InspectableExecutionNodeId>(
        (currentGraphEvent ? nodeIdsForEvent(currentGraphEvent) : []).filter(
          (nodeId): nodeId is InspectableExecutionNodeId => isInspectableNode(nodeId)
        )
      ),
    [currentGraphEvent]
  )
  const interactiveNodeIds = terminalInspection ? undefined : currentInspectableNodeIds
  const unobservedLegendLabel = runEnded(whole.status) ? 'Never activated' : 'Not activated yet'

  // A cited source opens its node. Choosing or closing a node wins until another citation.
  const [selectedNodeId, setSelectedNodeId] = useState<InspectableExecutionNodeId | null>(null)
  const [sql, setSql] = useState<string | null>(null)
  const focusKey = focus ? `${focus.invocationId ?? ''}|${focus.referenceId ?? ''}` : null
  const focusCall = focusedCall(whole, focus)
  const focusNodeId = focusCall ? nodeOfCall(focusCall, events) : null
  const [handledFocusKey, setHandledFocusKey] = useState<string | null>(null)
  if (focusKey !== handledFocusKey && focusNodeId) {
    setHandledFocusKey(focusKey)
    setSelectedNodeId(focusNodeId)
  }

  const selectedInspectorActive = Boolean(
    selectedNodeId && (terminalInspection || currentInspectableNodeIds.has(selectedNodeId))
  )
  const selectedDetail = useMemo(() => {
    if (!selectedNodeId) return null
    const detailGraph = selectedInspectorActive ? graph : fullGraph
    const detailProjection = selectedInspectorActive ? shownProjection : wholeProjection
    const node = detailGraph.nodes.find((candidate) => candidate.id === selectedNodeId)
    return node && isInspectableExecutionNodeState(node.state)
      ? buildExecutionNodeDetail(selectedNodeId, detailGraph, detailProjection)
      : null
  }, [fullGraph, graph, selectedInspectorActive, selectedNodeId, shownProjection, wholeProjection])
  const selectedReplayScopeState = useMemo<ReplayScopeState>(() => {
    if (!selectedNodeId) return 'past'
    const current = replay.step - 1
    const matching = allGraphEvents.flatMap((event, index) =>
      nodeIdsForEvent(event).includes(selectedNodeId) ? [index] : []
    )
    if (!matching.some((index) => index < current)) return 'future'
    return matching.some((index) => index > current) ? 'between' : 'past'
  }, [allGraphEvents, replay.step, selectedNodeId])

  const closeInspector = useCallback((): void => {
    setSql(null)
    setSelectedNodeId(null)
  }, [])
  const handleNodeSelect = (nodeId: InspectableExecutionNodeId): void => {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId)
    if (
      !node ||
      !isInspectableExecutionNodeState(node.state) ||
      (interactiveNodeIds && !interactiveNodeIds.has(nodeId))
    ) {
      return
    }
    setSql(null)
    setSelectedNodeId(nodeId)
  }

  // Live activity: what the agent is doing now, while the run streams
  const followingLive = liveMode && atEnd && whole.status === 'running'
  const activeCall = shown.toolCalls.findLast((call) => call.state === 'running')
  const activeSince = activeCall?.startedAt ?? whole.startedAt
  const [clockMs, setClockMs] = useState(() => Date.now())
  useEffect(() => {
    if (!followingLive) return
    setClockMs(Date.now())
    const interval = window.setInterval(() => setClockMs(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [followingLive])
  const activeElapsedSeconds = activeSince
    ? Math.max(0, Math.floor((clockMs - Date.parse(activeSince)) / 1_000))
    : 0
  const activeComponent: GraphComponent = activeCall
    ? (shownProjection.invocations.find((call) => call.invocationId === activeCall.invocationId)
        ?.component ?? 'tool')
    : 'agent'

  const graphLayerRef = useRef<HTMLDivElement>(null)
  const dataViewerOpen = sql !== null || (selectedDetail?.id === 'structured-database' && liveMode)
  const inspectorOpen = Boolean(selectedDetail) || dataViewerOpen
  useEffect(() => {
    const layer = graphLayerRef.current
    if (!layer) return
    if (inspectorOpen) layer.setAttribute('inert', '')
    else layer.removeAttribute('inert')
  }, [inspectorOpen])

  const graphStatus = shownProjection.status
  const modeLabel = !events.length
    ? liveMode
      ? 'Awaiting Native Events'
      : 'No Events'
    : followingLive
      ? 'Hermes Live'
      : 'Hermes Recorded'

  let inspector: ReactNode = null
  if (dataViewerOpen) {
    inspector = (
      <section
        className={styles.capabilityExplorer}
        aria-label="Structured database"
        data-testid="capability-explorer"
      >
        <div className="flex justify-end px-4 pt-3">
          <button
            type="button"
            className={styles.iconButton}
            // Back to the explorer the query came from, else close
            onClick={sql !== null && selectedDetail ? () => setSql(null) : closeInspector}
            aria-label="Close the data viewer"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DatabaseBrowser sourceIds={structuredSources} sql={sql ?? ''} onSqlChange={setSql} />
        </div>
      </section>
    )
  } else if (selectedDetail && !selectedInspectorActive) {
    inspector = (
      <ReplayScopedInspectorNotice
        detail={selectedDetail}
        currentStep={replay.step}
        currentLabel={stepLabel(currentEvent)}
        scopeState={selectedReplayScopeState}
        onClose={closeInspector}
      />
    )
  } else if (selectedDetail) {
    const invocationIds = new Set(selectedDetail.invocations.map((call) => call.invocationId))
    // The agent's explorer lists every call it made
    const calls = shown.toolCalls.filter(
      (call) => selectedDetail.id === 'hermes-agent' || invocationIds.has(call.invocationId)
    )
    const tools = new Set(calls.map((call) => call.tool?.id))
    const description =
      tools.size === 1 && calls[0]?.tool ? calls[0].tool.description : selectedDetail.subtitle
    inspector = (
      <div className={styles.capabilityExplorer} data-testid="capability-explorer">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <CapabilityExplorer
            key={selectedDetail.id}
            title={selectedDetail.label}
            description={description}
            calls={calls}
            receipts={receipts}
            focusReceiptId={focus?.referenceId ?? null}
            phoenixUrl={liveMode ? phoenixUrl : null}
            onOpenQuery={liveMode ? setSql : undefined}
            onClose={closeInspector}
          />
        </div>
      </div>
    )
  }

  return (
    <section
      className={styles.workspace}
      aria-label="Execution workspace"
      data-live={followingLive || undefined}
    >
      {!inspectorOpen && (
        <header className={styles.workspaceHeader}>
          <div className={styles.workspaceTitle}>
            <span className={styles.eyebrow}>Inspectable trajectory</span>
            <h2>Execution Graph</h2>
            <div className={styles.runMetadata}>
              <span className={styles.modeBadge} data-live={followingLive || undefined}>
                <span className={styles.statusDot} />
                {modeLabel}
              </span>
              <span className={styles.runStatus} data-state={graphStatus}>
                {graphStatus}
              </span>
              <code title={jobId}>{jobId}</code>
            </div>
          </div>
          <button type="button" className={styles.backButton} onClick={onClose}>
            <span aria-hidden="true">←</span>
            Back to Answer
          </button>
        </header>
      )}

      {followingLive && (
        <section className={styles.liveActivity} data-testid="live-execution-activity">
          <span className={styles.liveActivityPulse} aria-hidden="true" />
          <div className={styles.liveActivityCopy}>
            <small>Live · {LIVE_OWNERS[activeComponent]}</small>
            <strong aria-live="polite">{liveActivityDescription(activeCall)}</strong>
          </div>
          <div className={styles.liveActivityTiming}>
            <strong aria-hidden="true">{formatElapsed(activeElapsedSeconds)} elapsed</strong>
            <small>Run active · waiting for the display-safe result</small>
          </div>
        </section>
      )}

      <ReplayControls replay={replay} currentLabel={stepLabel(currentEvent)} />

      {runEnded(shown.status) && (
        <RunSummary run={shown} citedEvidenceIds={stored?.citedEvidenceIds ?? null} />
      )}

      <div className={styles.graphRegion}>
        {events.length === 0 ? (
          <p className="text-secondary p-5 text-sm">
            {exportState === 'loading'
              ? 'Loading the run…'
              : 'No execution record is available for this answer.'}
          </p>
        ) : (
          <div
            ref={graphLayerRef}
            className={styles.graphInteractiveLayer}
            aria-hidden={inspectorOpen ? 'true' : undefined}
          >
            <ExecutionGraph
              model={graph}
              selectedNodeId={selectedNodeId}
              interactiveNodeIds={interactiveNodeIds}
              unobservedLegendLabel={unobservedLegendLabel}
              structuredDatabaseProviderMark={
                structuredSources.length === 1 ? DUCKDB_MARK : undefined
              }
              gpuAccelerations={gpuAccelerations}
              nodeLogos={NODE_LOGOS}
              onNodeSelect={handleNodeSelect}
            />
          </div>
        )}
        {inspector}
      </div>
    </section>
  )
}
