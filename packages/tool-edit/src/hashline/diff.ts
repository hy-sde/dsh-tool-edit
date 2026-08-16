/**
 * Read-only hashline diff preview helpers (args-complete pass): read the
 * target file, parse + apply the section's edits in memory (no FS write, no
 * LSP writethrough), then hand the before/after pair to
 * {@link generateDiffString}. The streaming-tolerant applier is NOT ported;
 * only the streaming-tolerant option sets on the shared helpers remain.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import * as path from 'node:path'
import {
  applyEdits,
  type ApplyEditsOptions,
  type ApplyResult,
  type Clipboard,
  computeFileHash,
  type Edit,
  hasBlockEdit,
  Patch as HashlinePatch,
  MismatchError,
  missingSnapshotTagMessage,
  normalizeToLF,
  type Patch,
  type PatchSection,
  Recovery,
  resolveBlockEdits,
  type SnapshotStore,
  stripBom,
  validateClipboardSequence,
} from '@hy-sde/dsh-hashline'
import { generateDiffString } from '../diff.ts'
import type { FileReader } from '../session.ts'
import { nativeBlockResolver } from './block-resolver.ts'

export interface HashlineDiffOptions {
  /**
   * Accepted values from the original containing the streaming option; the
   * harness port always uses the args-complete path, so `streaming` selects
   * the strict/no-stream behavior. Kept for interface parity.
   */
  streaming?: boolean
  /**
   * Skip snapshot-tag validation (original streaming-preview behavior).
   * The final apply path still validates through Patcher.
   */
  skipHashValidation?: boolean
  /** Clipboard register shared across the sections of one patch preview. */
  clipboard?: Clipboard
  /** Harness reader used for preview reads (required). */
  reader?: FileReader
}

function hasAnchorScopedEdit(edits: readonly Edit[]): boolean {
  return edits.some((edit) => {
    if (edit.kind === 'delete' || edit.kind === 'block' || edit.kind === 'cut') return true
    if (edit.kind === 'paste') {
      if (edit.at.kind === 'span') return true
      return edit.at.cursor.kind === 'before_anchor' || edit.at.cursor.kind === 'after_anchor'
    }
    return edit.cursor.kind === 'before_anchor' || edit.cursor.kind === 'after_anchor'
  })
}

function createMismatchError(
  section: PatchSection,
  absolutePath: string,
  normalized: string,
  snapshots: SnapshotStore,
  expected: string,
): MismatchError {
  return new MismatchError({
    path: section.path,
    expectedFileHash: expected,
    actualFileHash: computeFileHash(normalized),
    fileLines: normalized.split('\n'),
    anchorLines: section.collectAnchorLines(),
    hashRecognized: snapshots.byHash(absolutePath, expected) !== null,
  })
}

function resolvePreviewEdits(args: {
  section: PatchSection
  absolutePath: string
  normalized: string
  snapshots: SnapshotStore
  expected: string | undefined
  liveMatches: boolean
  edits: readonly Edit[]
}): readonly Edit[] {
  const { section, absolutePath, normalized, snapshots, expected, liveMatches, edits } = args
  if (!hasBlockEdit(edits)) return edits
  const baseText = expected === undefined || liveMatches ? normalized : snapshots.byHash(absolutePath, expected)?.text
  if (baseText === undefined) {
    throw createMismatchError(section, absolutePath, normalized, snapshots, expected ?? '')
  }
  return resolveBlockEdits(edits, baseText, section.path, nativeBlockResolver, { onUnresolved: 'throw' })
}

function applyPreviewEdits(args: {
  section: PatchSection
  absolutePath: string
  normalized: string
  snapshots: SnapshotStore
  options: HashlineDiffOptions
}): ApplyResult {
  const { section, absolutePath, normalized, snapshots, options } = args
  const expected = section.fileHash
  if (!options.skipHashValidation && expected === undefined) {
    throw new Error(missingSnapshotTagMessage(section.path))
  }
  // The 4-hex tag is content-derived: when the live text hashes to it, trust
  // the match and preview directly (mirrors Patcher's apply-time behavior).
  const liveMatches = expected !== undefined && computeFileHash(normalized) === expected
  const edits = section.edits
  const resolved = resolvePreviewEdits({ section, absolutePath, normalized, snapshots, expected, liveMatches, edits })
  const clipboard = options.clipboard ?? {}
  // Mirror the Patcher: surface clipboard sequencing mistakes with their
  // targeted message before the recovery path below swallows them.
  validateClipboardSequence(resolved, clipboard)
  const applyOptions: ApplyEditsOptions = { clipboard, path: absolutePath }
  if (options.skipHashValidation || expected === undefined || liveMatches) {
    return applyEdits(normalized, resolved, applyOptions)
  }
  if (!hasAnchorScopedEdit(resolved)) return applyEdits(normalized, resolved, applyOptions)

  const recovered = new Recovery(snapshots).tryRecover({
    path: absolutePath,
    currentText: normalized,
    fileHash: expected,
    edits: resolved,
    clipboard,
  })
  if (recovered) {
    return { text: recovered.text, ...(recovered.firstChangedLine === undefined ? {} : { firstChangedLine: recovered.firstChangedLine }), warnings: recovered.warnings }
  }
  throw createMismatchError(section, absolutePath, normalized, snapshots, expected)
}

/** Resolve an authored path to its absolute form under `cwd`. */
function resolveToCwd(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
}

/**
 * Compute the before/after diff for one hashline section (args-complete pass;
 * the streaming-tolerant variant from the original is not ported). Reads go
 * through the harness file reader when provided.
 */
export async function computeHashlineSectionDiff(
  section: PatchSection,
  cwd: string,
  snapshots: SnapshotStore,
  options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
  try {
    const absolutePath = resolveToCwd(section.path, cwd)
    if (!options.reader) {
      return { error: 'Hashline diff preview requires a file reader.' }
    }
    const target = await options.reader.resolve(absolutePath, undefined)
    let rawContent: string
    try {
      rawContent = await options.reader.readText(target)
    } catch {
      return { error: `File not found: ${section.path}` }
    }
    const { text } = stripBom(rawContent)
    const normalized = normalizeToLF(text)
    const result = applyPreviewEdits({ section, absolutePath, normalized, snapshots, options })
    if (normalized === result.text) {
      // REM/MV-only sections change no text; the header conveys the op.
      if (section.fileOp) return { diff: '', firstChangedLine: undefined }
      return { error: `No changes would be made to ${section.path}.` }
    }
    return generateDiffString(normalized, result.text, undefined, { path: section.path })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Compute the before/after diff for a full hashline input payload.
 * Only single-section input is supported, matching the original's streaming
 * preview contract.
 */
export async function computeHashlineDiff(
  input: { input: string },
  cwd: string,
  snapshots: SnapshotStore,
  options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
  let patch: Patch
  try {
    patch = HashlinePatch.parse(input.input, { cwd })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  if (patch.sections.length !== 1) {
    return { error: 'Streaming diff preview supports exactly one hashline section.' }
  }
  return computeHashlineSectionDiff(patch.sections[0] as PatchSection, cwd, snapshots, options)
}
