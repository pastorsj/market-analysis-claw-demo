// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@/test-utils'
import { describe, expect, test } from 'vitest'
import { EcosystemLanding } from './EcosystemLanding'

const QUESTION = {
  id: 'market-leaders',
  label: 'Market Leaders',
  question: 'Which assets had the strongest returns?',
  sources: ['market_analysis_structured'],
  featured: true,
}

describe('EcosystemLanding', () => {
  test('presents the architecture and enters the research view', () => {
    render(<EcosystemLanding featuredQuestions={[]} disclaimer={null} />)

    expect(
      screen.getByRole('heading', { name: 'From market question to grounded decision.' })
    ).toBeInTheDocument()
    expect(screen.getAllByTestId('ecosystem-node')).toHaveLength(6)
    expect(screen.getByRole('link', { name: /Enter market analysis/ })).toHaveAttribute(
      'href',
      '/research'
    )
    expect(screen.queryByRole('heading', { name: 'Featured questions' })).not.toBeInTheDocument()
  })

  test('links each featured question to the research view', () => {
    render(
      <EcosystemLanding
        featuredQuestions={[QUESTION]}
        disclaimer="Synthetic market data. Not investment advice."
      />
    )

    expect(screen.getByText('Synthetic market data. Not investment advice.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Market Leaders/ })).toHaveAttribute(
      'href',
      '/research?question=market-leaders'
    )
  })
})
