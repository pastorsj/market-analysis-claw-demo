// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import type { ReceiptV2 } from '../contract'
import type { ToolCall } from '../projection'
import { receiptOf } from '../test-utils/fixtures'
import { CapabilityExplorer } from './CapabilityExplorer'

const callFor = (receipts: ReceiptV2[], state: ToolCall['state'] = 'completed'): ToolCall => ({
  invocationId: 'call-1',
  name: 'ask_question',
  tool: undefined,
  label: 'Auto Ontology',
  family: 'structured_retrieval',
  state,
  startedAt: '2026-09-28T05:00:00Z',
  endedAt: null,
  receiptIds: receipts.map((receipt) => receipt.receiptId),
})

const renderExplorer = (receipts: ReceiptV2[], props: { state?: ToolCall['state'] } = {}) => {
  const onOpenQuery = vi.fn()
  render(
    <CapabilityExplorer
      title="Auto Ontology"
      description={null}
      calls={[callFor(receipts, props.state)]}
      receipts={Object.fromEntries(receipts.map((receipt) => [receipt.receiptId, receipt]))}
      phoenixUrl="http://127.0.0.1:6006"
      onOpenQuery={onOpenQuery}
      onClose={vi.fn()}
    />
  )
  return onOpenQuery
}

describe('CapabilityExplorer', () => {
  it('opens a receipt’s SQL in the data viewer and links its span in Phoenix', async () => {
    const sql = receiptOf('structured_query')
    const onOpenQuery = renderExplorer([sql])
    await userEvent.click(screen.getByRole('button', { name: 'Open in data viewer' }))
    expect(onOpenQuery).toHaveBeenCalledWith(sql.content!.sql)
    expect(screen.getByRole('link', { name: /Open this call in Phoenix/ })).toHaveAttribute(
      'href',
      `http://127.0.0.1:6006/redirects/spans/${sql.spanId}`
    )
  })

  it('switches between the calls of one node', async () => {
    renderExplorer([
      receiptOf('structured_prediction'),
      receiptOf('structured_prediction', 'failed'),
    ])
    expect(
      screen.getByText('evidence_unavailable: ConnectError: [Errno 111] Connection refused')
    ).toBeVisible()
    await userEvent.click(screen.getByRole('radio', { name: 'Call 1' }))
    expect(screen.getByText('news_event')).toBeVisible()
  })

  it('says why there is nothing to show yet', () => {
    renderExplorer([], { state: 'running' })
    expect(screen.getByText(/still running/)).toBeVisible()
  })
})
