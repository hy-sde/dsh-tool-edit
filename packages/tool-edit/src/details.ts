/**
 * Tool result details shape for the `edit` tool diff cards, plus a tiny
 * hunk-diff helper (adapted from tool-fs's `computeHunkDiffs`) inlined so
 * `presentResult` can derive before/after diffs without depending on
 * `@deepseek-ai/dsh-tool-fs`.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */

/** One side of a file diff used by tool presentResult cards. */
export interface FileDiff {
  path: string
  oldText: string | null
  newText: string
}

/**
 * The executed edit result details. Used for presentResult diff cards and
 * the model-facing output text; `oldText`/`newText` are the raw before/after
 * snapshots (pruned by the harness caller if needed).
 */
export interface EditToolPerFileDetails {
  diff: string
  path: string
  firstChangedLine?: number
  diagnostics?: { summary: string; messages: readonly unknown[] }
  oldText?: string
  newText?: string
}

import { structuredPatchHunks } from './diff.ts'

/**
 * Derive one {@link FileDiff}-card per changed hunk region between `before`
 * and `after` (hard-coded 3 context lines, matching tool-fs/diff.ts).
 */
export function computeHunkDiffs(path: string, before: string, after: string): FileDiff[] {
  const hunks = structuredPatchHunks(before, after, 3)
  const diffs: FileDiff[] = []
  for (const hunk of hunks) {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const rawLine of hunk.lines) {
      const line = rawLine ?? ''
      if (line.startsWith('\\')) continue
      const text = line.slice(1)
      if (line.startsWith('-')) oldLines.push(text)
      else if (line.startsWith('+')) newLines.push(text)
      else {
        oldLines.push(text)
        newLines.push(text)
      }
    }
    if (oldLines.length === 0 && newLines.length === 0) continue
    diffs.push({
      path,
      oldText: oldLines.length > 0 ? oldLines.join('\n') : null,
      newText: newLines.join('\n'),
    })
  }
  return diffs
}

/** Narrow opaque result metadata to validated file diffs (like diffsFromMeta). */
export function fileDiffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const isFileDiff = (value: unknown): value is FileDiff => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const { path, oldText, newText } = value as Record<string, unknown>
    return typeof path === 'string'
      && (oldText === null || typeof oldText === 'string')
      && typeof newText === 'string'
  }
  if (!diffs.every(isFileDiff)) return undefined
  return diffs as FileDiff[]
}
