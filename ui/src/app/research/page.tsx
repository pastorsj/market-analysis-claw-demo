// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Research Page
 *
 * The chat experience. `?question=<id>` (from the landing page) places that
 * featured question of the active data pack in the composer.
 */

import { type ReactNode, Suspense } from 'react'
import { fetchPack } from '@/adapters/api/pack-client'
import { MainLayout, type InitialQuestion } from '@/features/layout'
import { readUiMode } from '@/shared/config/env'

interface ResearchPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const loadInitialQuestion = async (questionId: unknown): Promise<InitialQuestion | null> => {
  if (typeof questionId !== 'string' || readUiMode() !== 'live') return null
  const question = (await fetchPack())?.questions.find((q) => q.id === questionId)
  return question ? { question: question.question, sourceIds: question.sources } : null
}

const ResearchPage = async ({ searchParams }: ResearchPageProps): Promise<ReactNode> => {
  const initialQuestion = await loadInitialQuestion((await searchParams).question)

  // MainLayout reads the ?session= parameter, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <MainLayout initialQuestion={initialQuestion} />
    </Suspense>
  )
}

export default ResearchPage
