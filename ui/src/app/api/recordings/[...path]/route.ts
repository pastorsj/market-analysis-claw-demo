// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recordings Route
 *
 * Serves the active data pack's replay bundle, read-only, from
 * `$PACKS_DIR/$DATA_PACK/recordings` (e.g. `/api/recordings/index.json`).
 * Only JSON and JSON Lines files inside that directory are served.
 */

import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { readRecordingsDir } from '@/shared/config/env'

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
}

/** One path segment: no traversal, no hidden files. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

const notFound = (): Response =>
  Response.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const segments = (await params).path
  const contentType = CONTENT_TYPES[path.extname(segments.at(-1) ?? '')]
  if (!contentType || !segments.every((segment) => SEGMENT.test(segment))) return notFound()

  try {
    // Resolve symlinks on both sides so a link cannot escape the bundle.
    const root = await realpath(readRecordingsDir())
    const file = await realpath(path.join(root, ...segments))
    if (!file.startsWith(root + path.sep)) return notFound()
    return new Response(await readFile(file), {
      headers: { 'content-type': contentType, 'cache-control': 'no-cache' },
    })
  } catch {
    return notFound()
  }
}
