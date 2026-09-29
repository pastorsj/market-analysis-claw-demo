<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Execution feature

What the agent did for an answer: a graph of the run (Hermes agent in its OpenShell sandbox,
Switchyard model calls, tool calls, the services behind them), a timeline, an explorer per tool
call built from its receipt, a data viewer, a Phoenix link and step-by-step replay. It plugs into
the base UI through the one `ExecutionFeature` slot (`@/shared/context`), wired in
`app/providers.tsx`.

## Data flow

```text
live:   SSE `execution.v2`, `job.status` ───┐
        GET /v1/jobs/async/job/{id}/export ─┤ (receipts, and the events of an earlier run)
replay: /api/recordings/sessions/<id>.json ─┘
                                            ▼
      store.ts (runs by job id: events, receipts, job status; nothing persisted)
                                            ▼
     projection.ts (events up to the replay cursor → tool calls, model calls, status)
          ▼                      ▼                           ▼
 graph/view-model.ts   timeline/timeline-model.ts   explorers/* (receipt → sections)
          ▼                      ▼                           ▼
 graph/FlowCanvas.tsx  timeline/ExecutionTimeline   explorers/CapabilityExplorer.tsx
                                            ▼
                               ExecutionWorkspace.tsx
```

The types are generated from the API's models (`@/generated`, never edited by hand) and every
tool name, label and explorer comes from the tool registry (`TOOL_REGISTRY`). The view-models are
pure functions; components only compose them with KUI and the upstream `ResultChart`.

## Files

| Path                        | Role                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `contract.ts`               | Shape guard for events and receipts; anything else is dropped and counted                                          |
| `registry.ts`               | Tool lookup by MCP or Hermes name; the resource behind each capability family                                      |
| `store.ts`, `projection.ts` | Run state, and its reduction to what the views show                                                                |
| `graph/`                    | Layered layout (no layout library), graph view-model, React Flow canvas (loaded with `next/dynamic`)               |
| `explorers/`                | One builder per explorer (`retrieval`, `market`, `sql`, `ontology`, `pql`); `index.ts` picks one by `artifactKind` |
| `timeline/`                 | Timeline rows and the Agent Activity side panel                                                                    |
| `replay/`                   | Recordings bundle and job export (`sources.ts`), the replay cursor and its controls                                |
| `data-viewer/`              | Tables, previews and read-only SQL of a structured source (live mode)                                              |
| `trace-link.ts`             | Phoenix trace and span links (shown when `PHOENIX_URL` is set)                                                     |

## API it reads

- `GET /v1/jobs/async/job/{id}/export`: one turn, `{jobId, question, …, events, receipts}`.
- `GET /v1/jobs/async/job/{id}/trace`: `{trace_id}`, linked as `<PHOENIX_URL>/redirects/traces/<id>`.
- `GET /v1/jobs/async/job/{id}/stream`: the `execution.v2` events, and `job.status`, whose final
  status (`success`, `failure`, `interrupted`) decides how the run ended.
- `GET /v1/data_sources/{id}/schema`, `…/preview?table=&limit=`, `…/ontology` (404 hides it), and
  `POST …/query {sql}`.
- Replay mode reads only `/api/recordings/index.json` and `/api/recordings/sessions/<id>.json`
  (bundle v2, written by `scripts/demo.sh record`) and never calls the API.

## Adding a tool

Add it to `contracts/tool-registry.json` and regenerate. A tool with an existing `receipt_kind`
needs no UI change. A new kind adds a receipt model in the API, a builder under `explorers/`, a
`case` in `explorers/index.ts` and an entry in `ARTIFACT_KINDS` (`contract.ts`), which TypeScript
then requires.

## Tests

`npm test` runs the specs next to each module against the golden fixtures in
`contracts/fixtures/`. `npm run e2e` replays the synthetic bundle in
`e2e/fixtures/packs/e2e/recordings/` in a browser.
