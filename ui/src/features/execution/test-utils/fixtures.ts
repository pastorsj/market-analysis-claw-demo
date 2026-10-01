// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The golden contract fixtures (contracts/fixtures) and the e2e recordings
 * bundle, for specs. Read from disk at test time: the UI image is built from
 * ui/ alone, so nothing under contracts/ may be imported.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ArtifactKind, ExecutionEventV2, ReceiptV2, RetrievalBenchmark } from '../contract'

const readJson = (...parts: string[]): unknown =>
  JSON.parse(readFileSync(path.resolve(process.cwd(), ...parts), 'utf8'))

/** One recorded run: a market anomaly scan and a document retrieval, plus two model calls. */
export const fixtureEvents = readJson(
  '../contracts/fixtures/execution-events.json'
) as ExecutionEventV2[]

/** One completed receipt per artifactKind, and a failed prediction. */
export const fixtureReceipts = readJson('../contracts/fixtures/receipts.json') as ReceiptV2[]

export const receiptOf = <K extends ArtifactKind>(
  kind: K,
  status: ReceiptV2['status'] = 'completed'
): Extract<ReceiptV2, { artifactKind: K }> =>
  fixtureReceipts.find(
    (receipt) => receipt.artifactKind === kind && receipt.status === status
  ) as Extract<ReceiptV2, { artifactKind: K }>

/** A Milvus comparison on a GPU stack: CPU faster for single queries, the GPU for batches and concurrency. */
export const [fixtureRetrievalBenchmark] = readJson(
  '../contracts/fixtures/retrieval-benchmarks.json'
) as RetrievalBenchmark[]

export const readRecording = (file: string): unknown =>
  readJson('e2e/fixtures/packs/e2e/recordings', file)
