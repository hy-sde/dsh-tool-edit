/**
 * Stub: the original used a native tree-sitter parser (enclosingBlockBoundaries) for replacement-boundary repair and parse probing. Without it this module withholds structural proof (returns [] / false), which is the documented graceful-degradation path for unrecognized languages — identical semantics to running the original without native support.
 * Ported from @oh-my-pi/hashline (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */

import { hashString } from './hash.ts'

/** Parse-result cache keyed by content hash + path; FIFO-bounded. */
const parseCache = new Map<string, boolean>()
const PARSE_CACHE_MAX = 256

const boundaryCache = new Map<string, readonly number[]>()

/** Syntactic node boundaries outside a visible source range. */
export function enclosingBoundaries(
  lines: readonly string[],
  path: string,
  startLine: number,
  endLine: number,
): readonly number[] {
  const text = lines.join('\n')
  const key = `${hashString(text).toString(36)}:${text.length}:${path}:${startLine}:${endLine}`
  const cached = boundaryCache.get(key)
  if (cached !== undefined) return cached
  const boundaries: readonly number[] = []
  if (boundaryCache.size >= PARSE_CACHE_MAX) {
    const oldest = boundaryCache.keys().next().value
    if (oldest !== undefined) boundaryCache.delete(oldest)
  }
  boundaryCache.set(key, boundaries)
  return boundaries
}

/**
 * `true` when `text` parses without a syntax error under the language inferred
 * from `path`. `false` covers "does not parse" and "cannot tell" alike — no
 * path, an unrecognized language, or a native failure — because both mean the
 * probe has nothing to prove with. Callers must therefore never treat `false`
 * as evidence *about the edit*: it only withholds permission to rewrite.
 *
 * Stub: always returns `false` (see module note) — the probe has nothing to
 * prove with, so no structural rewrite is ever permitted.
 */
export function parsesCleanly(path: string | undefined, text: string): boolean {
  if (path === undefined) return false
  const key = `${hashString(text).toString(36)}:${text.length}:${path}`
  const cached = parseCache.get(key)
  if (cached !== undefined) return cached
  const ok = false
  if (parseCache.size >= PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value
    if (oldest !== undefined) parseCache.delete(oldest)
  }
  parseCache.set(key, ok)
  return ok
}
