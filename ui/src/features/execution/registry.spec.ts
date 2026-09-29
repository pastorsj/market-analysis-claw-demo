// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { TOOL_REGISTRY } from '@/generated/tool-registry'
import { RESOURCES, toolFor } from './registry'
import { fixtureEvents, fixtureReceipts } from './test-utils/fixtures'

describe('tool registry', () => {
  it('finds every tool by MCP name and by Hermes name, and the names are unique', () => {
    const names = TOOL_REGISTRY.tools.flatMap((tool) => [tool.id, tool.hermes_name])
    expect(new Set(names).size).toBe(names.length)
    for (const tool of TOOL_REGISTRY.tools) {
      expect(toolFor(tool.id)).toBe(tool)
      expect(toolFor(tool.hermes_name)).toBe(tool)
    }
  })

  it('knows every tool the golden events and receipts name', () => {
    const names = [
      ...fixtureEvents.flatMap((event) => event.toolName ?? []),
      ...fixtureReceipts.map((receipt) => receipt.toolName),
    ]
    for (const name of names) expect(toolFor(name), name).toBeDefined()
  })

  it('has a resource for every family and matches receipts to their kind', () => {
    for (const tool of TOOL_REGISTRY.tools) expect(RESOURCES[tool.family]).toBeDefined()
    for (const receipt of fixtureReceipts) {
      expect(toolFor(receipt.toolName)?.receipt_kind).toBe(receipt.artifactKind)
    }
  })

  it('returns undefined for an unregistered tool', () => {
    expect(toolFor('web_search')).toBeUndefined()
    expect(toolFor(null)).toBeUndefined()
  })
})
