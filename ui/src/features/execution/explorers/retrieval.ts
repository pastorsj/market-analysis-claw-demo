// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** `retrieve_evidence`: per-source vector search in Milvus, one rerank, the best passages. */

import type { RetrievalEvidence } from '@/generated/receipt'
import { formatDuration, formatNumber } from '../format'
import { facts, sections } from './sections'
import type { EvidenceSection } from './types'

const citationOf = (metadata: Record<string, unknown>): string | null =>
  typeof metadata.citation === 'string' ? metadata.citation : null

/** Only web links become anchors; a `javascript:` URL would run in the UI's origin. */
const webLink = (url: string | null): string | null =>
  url && /^https?:\/\//i.test(url) ? url : null

export const retrievalSections = (content: RetrievalEvidence): EvidenceSection[] => {
  const { timings, models, index } = content
  return sections(
    facts('Search', [
      ['Query', content.query],
      ['Sources', content.sourceIds.join(', ')],
      ['Collection', content.collection],
      ['Index build', content.collectionVersion],
      ['Index', `${index.type} · ${index.metric}`],
      ['Embedding model', models.embed],
      ['Reranker', models.rerank],
      [
        'Candidates',
        Object.entries(content.candidateCounts)
          .map(([source, count]) => `${source} ${count}`)
          .join(' · '),
      ],
    ]),
    content.hits.length > 0 && {
      kind: 'passages',
      title: `Passages (${content.hits.length})`,
      passages: content.hits.map((hit) => ({
        id: hit.chunkId,
        title: `${hit.rank}. ${hit.title}`,
        text: hit.snippet,
        source: [hit.sourceId, hit.publishedAt?.slice(0, 10)].filter(Boolean).join(' · '),
        url: webLink(hit.url),
        citation: citationOf(hit.metadata),
        score: `rerank ${formatNumber(hit.score)} · cosine ${formatNumber(hit.vectorScore)}`,
      })),
    },
    facts('Timing', [
      ['Embed', formatDuration(timings.embedMs)],
      ['Vector search', formatDuration(timings.searchMs)],
      ['Rerank', formatDuration(timings.rerankMs)],
      ['Total', formatDuration(timings.totalMs)],
    ])
  )
}
