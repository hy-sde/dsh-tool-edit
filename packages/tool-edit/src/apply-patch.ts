/**
 * Multi-file orchestrator for the Codex `apply_patch` envelope, plus the
 * `*** Begin Patch` parser (codex-style apply-patch grammar, see
 * `./apply-patch.lark` for the reference grammar — documented asset, not
 * imported).
 *
 * Decoupled from tool registration: takes raw patch text + options, parses
 * it, and applies each hunk via the existing single-file `applyPatch` in
 * `./patch.ts`. Per spec §6.1 hunks are applied in order and NOT atomically —
 * if hunk N fails, hunks 0..N-1 are already on disk. We surface that by
 * returning the per-file results alongside the error.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import { ApplyPatchError, ParseError } from './diff.ts'
import { applyPatch, type ApplyPatchOptions, type ApplyPatchResult, type PatchInput } from './patch.ts'

const BEGIN_PATCH_MARKER = '*** Begin Patch'
const END_PATCH_MARKER = '*** End Patch'
const ADD_FILE_MARKER = '*** Add File: '
const DELETE_FILE_MARKER = '*** Delete File: '
const UPDATE_FILE_MARKER = '*** Update File: '
const MOVE_TO_MARKER = '*** Move to: '

interface ParseApplyPatchOptions {
  streaming?: boolean
}

/**
 * Parse a Codex `*** Begin Patch` envelope into a list of single-file
 * patch inputs.
 */
export function parseApplyPatch(patchText: string): PatchInput[] {
  return parseApplyPatchWithOptions(patchText, {})
}

/**
 * Best-effort parser for in-progress TUI previews. It tolerates missing
 * envelope markers and incomplete trailing hunks; do not use it to apply edits.
 */
export function parseApplyPatchStreaming(patchText: string): PatchInput[] {
  return parseApplyPatchWithOptions(patchText, { streaming: true })
}

/** One per-file entry expanded from an apply-patch payload (see parseApplyPatch). */
export interface ApplyPatchEntry {
  path: string
  op?: 'create' | 'delete' | 'update'
  rename?: string
  diff?: string
}

/**
 * Expand an `input` payload into per-file patch entries. For cross-mode
 * `edit` calls (mode apply_patch) each entry is executed through the shared
 * patch engine.
 */
export function expandApplyPatchToEntries(options: { input: string }): ApplyPatchEntry[] {
  return parseApplyPatch(options.input) as unknown as ApplyPatchEntry[]
}

function parseApplyPatchWithOptions(patchText: string, options: ParseApplyPatchOptions): PatchInput[] {
  const streaming = options.streaming === true
  let lines = patchText.trim().split('\n')

  // Lenient heredoc strip: <<EOF / <<'EOF' / <<"EOF" ... EOF
  if (lines.length >= 2) {
    const first = lines[0] as string
    const last = (lines[lines.length - 1] as string).trim()
    const validOpeners = new Set(['<<EOF', "<<'EOF'", '<<"EOF"'])
    if (validOpeners.has(first) && last === 'EOF') {
      lines = lines.slice(1, lines.length - 1)
    }
  }

  if (lines.length === 0 || (lines[0] as string).trim() !== BEGIN_PATCH_MARKER) {
    if (streaming) return []
    throw new ParseError("The first line of the patch must be '*** Begin Patch'")
  }
  const hasEndMarker = (lines[lines.length - 1] as string).trim() === END_PATCH_MARKER
  if (!hasEndMarker && !streaming) {
    throw new ParseError("The last line of the patch must be '*** End Patch'")
  }

  const hunks: PatchInput[] = []
  let remaining = hasEndMarker ? lines.slice(1, lines.length - 1) : lines.slice(1)
  // Line numbers are 1-based and include the `*** Begin Patch` line (= 1).
  let lineNumber = 2

  while (remaining.length > 0) {
    // Blank separator lines between hunks are ignored (spec §3.3).
    if ((remaining[0] as string).trim() === '') {
      remaining = remaining.slice(1)
      lineNumber++
      continue
    }

    const firstLine = (remaining[0] as string).trim()

    if (firstLine.startsWith(ADD_FILE_MARKER)) {
      const path = firstLine.slice(ADD_FILE_MARKER.length)
      let contents = ''
      let consumed = 1

      for (let i = 1; i < remaining.length; i++) {
        const line = remaining[i] as string
        if (line.startsWith('+')) {
          contents += `${line.slice(1)}\n`
          consumed++
        } else {
          break
        }
      }

      hunks.push({ path, op: 'create', diff: contents })
      remaining = remaining.slice(consumed)
      lineNumber += consumed
      continue
    }

    if (firstLine.startsWith(DELETE_FILE_MARKER)) {
      const path = firstLine.slice(DELETE_FILE_MARKER.length)
      hunks.push({ path, op: 'delete' })
      remaining = remaining.slice(1)
      lineNumber++
      continue
    }

    if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
      const path = firstLine.slice(UPDATE_FILE_MARKER.length)
      remaining = remaining.slice(1)
      lineNumber++

      let movePath: string | undefined
      if (remaining.length > 0 && (remaining[0] as string).startsWith(MOVE_TO_MARKER)) {
        movePath = (remaining[0] as string).slice(MOVE_TO_MARKER.length)
        remaining = remaining.slice(1)
        lineNumber++
      }

      // The body runs until the next file-op marker or end of input.
      // `*** End of File` is a chunk-terminator and stays inside the body —
      // the downstream unified-diff parser handles it.
      const diffLines: string[] = []
      while (remaining.length > 0) {
        const line = remaining[0] as string
        if (
          line.startsWith('*** Add File:') ||
          line.startsWith('*** Delete File:') ||
          line.startsWith('*** Update File:')
        ) {
          break
        }
        diffLines.push(line)
        remaining = remaining.slice(1)
        lineNumber++
      }

      if (diffLines.length === 0) {
        if (streaming) {
          hunks.push({ path, op: 'update', diff: '', ...(movePath === undefined ? {} : { rename: movePath }) })
          continue
        }
        throw new ParseError(`Update file hunk for path '${path}' is empty`, lineNumber)
      }

      hunks.push({ path, op: 'update', diff: diffLines.join('\n'), ...(movePath === undefined ? {} : { rename: movePath }) })
      continue
    }

    if (streaming) {
      break
    }
    throw new ParseError(
      `'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
      lineNumber,
    )
  }

  return hunks
}

export interface ApplyCodexPatchResult {
  /** Single-file apply results in the order they were attempted. */
  results: ApplyPatchResult[]
  /** Affected file paths grouped by operation, for the §9.1 summary. */
  affected: {
    added: string[]
    modified: string[]
    deleted: string[]
  }
}

/**
 * Apply a full Codex `*** Begin Patch` envelope.
 *
 * Note: renames are reported under `modified` with the original path (spec
 * §9.1), not as a delete + add.
 */
export async function applyCodexPatch(patchText: string, options: ApplyPatchOptions): Promise<ApplyCodexPatchResult> {
  const hunks = parseApplyPatch(patchText)

  if (hunks.length === 0) {
    throw new ApplyPatchError('No files were modified.')
  }

  const results: ApplyPatchResult[] = []
  const affected = {
    added: [] as string[],
    modified: [] as string[],
    deleted: [] as string[],
  }

  for (const hunk of hunks) {
    const result = await applyPatch(hunk, options)
    results.push(result)
    recordAffected(affected, hunk)
  }

  return { results, affected }
}

function recordAffected(affected: ApplyCodexPatchResult['affected'], hunk: PatchInput): void {
  switch (hunk.op) {
    case 'create':
      affected.added.push(hunk.path)
      break
    case 'delete':
      affected.deleted.push(hunk.path)
      break
    case 'update':
      affected.modified.push(hunk.path)
      break
  }
}

/**
 * Format the A/M/D summary described in spec §9.1.
 */
export function formatApplyCodexPatchSummary(affected: ApplyCodexPatchResult['affected']): string {
  const lines = ['Success. Updated the following files:']
  for (const p of affected.added) lines.push(`A ${p}`)
  for (const p of affected.modified) lines.push(`M ${p}`)
  for (const p of affected.deleted) lines.push(`D ${p}`)
  return lines.join('\n')
}
