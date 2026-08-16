/**
 * Coding-agent runner that drives the hashline {@link Patcher} on behalf of
 * the `edit` tool. Converts an `{input}` tool-call payload into a fully
 * applied result wrapped in the tool's own shape, attaching warnings +
 * block resolutions and LSP diagnostics.
 *
 * Multi-section patches are preflighted up front via {@link Patcher.prepare}
 * so a partial batch never lands. Since the harness writethrough has no batch
 * machinery, section writes each round-trip their own diagnostics (merging
 * into the aggregate result); the flush flag from the original batch flow is
 * preserved as a no-op option for interface parity.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import {
  type BlockResolution,
  buildCompactDiffPreview,
  type Clipboard,
  commitClipboard,
  forkClipboard,
  MismatchError as HashlineMismatchError,
  Patch,
  Patcher,
  type PatchSectionResult,
  type PreparedSection,
  startClipboardBatch,
} from '@hy-sde/dsh-hashline'
import type { EditDiagnosticsResult } from '../lsp/writethrough.ts'
import type { EditSession } from '../session.ts'
import { generateDiffString } from '../diff.ts'
import { nativeBlockResolver } from './block-resolver.ts'
import { EditFilesystem } from './filesystem.ts'
import { hashPatchInput, NOOP_HARD_LIMIT, recordNoopEdit, resetNoopEdit } from './noop-loop-guard.ts'
import { type HashlineParams, hashlineEditParamsSchema } from './params.ts'
import { getSnapshotStore } from './store.ts'

export interface ExecuteHashlineSingleOptions {
  session: EditSession
  input: string
  signal?: AbortSignal
}

function noChangeDiagnostic(path: string): string {
  // The patch parsed and applied cleanly but produced no change — the
  // `+TEXT` body rows matched the file content at the targeted lines
  // byte-for-byte. The message names the cause directly so the next turn can
  // re-read instead of expanding the patch.
  return (
    `Edits to ${path} parsed and applied cleanly, but produced no change: ` +
    'your body row(s) are byte-identical to the file at the targeted lines. ' +
    'The bug is somewhere else — re-read the file before issuing another edit. ' +
    'Do NOT widen the payload or add lines; verify the anchor first.'
  )
}

/**
 * Escalated diagnostic surfaced once the same payload has no-op'd
 * {@link NOOP_HARD_LIMIT} times in a row on the same canonical path. Thrown as
 * an Error so the agent loop sees a tool *failure* — empirically far more
 * effective at breaking a no-op edit loop than the soft hint alone.
 */
function noChangeLoopDiagnostic(path: string, count: number): string {
  return (
    `STOP. Edits to ${path} have been a byte-identical no-op ${count} times in a row — ` +
    'the patch body matches the file at the targeted lines and the soft hint did not break the cycle. ' +
    'Cease re-issuing this payload. Either the intended change is already on disk (move on), ' +
    'or your anchor is wrong (re-read the file with `read` to observe the current line numbers and ' +
    'tag, then author a different edit). This exact payload will keep being rejected until it changes.'
  )
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
  const seen = new Map<string, string>()
  for (const entry of prepared) {
    const previous = seen.get(entry.canonicalPath)
    if (previous !== undefined) {
      throw new Error(
        `Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Merge their ops under one header before applying.`,
      )
    }
    seen.set(entry.canonicalPath, entry.section.path)
  }
}

interface RenderedSection {
  text: string
  details: HashlineSectionDetails
}

/** One rendered section outcome attached to the aggregate result. */
export interface HashlineSectionDetails {
  op: 'create' | 'update' | 'delete' | 'noop'
  path: string
  sourcePath?: string
  move?: string
  diff: string
  firstChangedLine?: number
  diagnostics?: EditDiagnosticsResult
  oldText?: string
  newText?: string
}

const BLOCK_OP_LABELS: Record<BlockResolution['op'], string> = {
  replace: 'PUT N*:',
  insert_after: 'PUT >N*:',
  cut: 'CUT N*',
  paste_after: 'PUT >N*',
}

function formatBlockResolution(resolution: BlockResolution): string {
  const op = BLOCK_OP_LABELS[resolution.op].replace('N', String(resolution.anchorLine))
  const lines = resolution.end - resolution.start + 1
  const span =
    resolution.start === resolution.end ? `line ${resolution.start}` : `lines ${resolution.start}-${resolution.end}`
  const suffix =
    resolution.op === 'insert_after'
      ? `; body lands after line ${resolution.end}`
      : resolution.op === 'paste_after'
        ? `; clipboard lands after line ${resolution.end}`
        : ''
  return `${op} → resolved ${span} (${lines} line${lines === 1 ? '' : 's'})${suffix}`
}

function renderSection(result: PatchSectionResult, diagnostics: EditDiagnosticsResult | undefined): RenderedSection {
  if (result.op === 'delete') {
    return {
      text: `Deleted ${result.path}`,
      details: { op: 'delete', path: result.path, diff: '', oldText: result.before },
    }
  }

  if (result.op === 'noop') {
    return {
      text: noChangeDiagnostic(result.path),
      details: { op: 'noop', path: result.path, diff: '' },
    }
  }

  const diff = generateDiffString(result.before, result.after, undefined, { path: result.path })
  const preview = buildCompactDiffPreview(diff.diff)
  const warningsBlock = result.warnings.length > 0 ? `\n\nWarnings:\n${result.warnings.join('\n')}` : ''
  const previewBlock = preview.preview ? `\n${preview.preview}` : ''
  const blockBlock =
    result.blockResolutions && result.blockResolutions.length > 0
      ? `\n${result.blockResolutions.map(formatBlockResolution).join('\n')}`
      : ''
  const moveBlock = result.moveDest ? `\nMoved to ${result.moveDest}` : ''
  const firstChangedLine = result.firstChangedLine ?? diff.firstChangedLine

  const text = `${result.header}${blockBlock}${moveBlock}${previewBlock}${warningsBlock}`

  return {
    text,
    details: {
      op: result.op,
      path: result.moveDest ?? result.path,
      ...(result.moveDest ? { sourcePath: result.path, move: result.moveDest } : {}),
      diff: diff.diff,
      ...(firstChangedLine === undefined ? {} : { firstChangedLine }),
      ...(diagnostics ? { diagnostics } : {}),
      oldText: result.before,
      newText: result.after,
    },
  }
}

/**
 * Execute one hashline edit: parse the payload, prepare and commit every
 * section, and return the rendered result. Throws on parse/apply/mismatch
 * failure per section before/while committing.
 */
export async function executeHashlineSingle(options: ExecuteHashlineSingleOptions): Promise<{
  text: string
  sections: HashlineSectionDetails[]
}> {
  const patch = Patch.parse(options.input, { cwd: options.session.cwd })
  if (patch.sections.length === 0) {
    throw new Error('No hashline sections found in input.')
  }

  const snapshots = getSnapshotStore(options.session.sessionKey)
  const fs = new EditFilesystem({
    session: options.session,
    snapshots,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const enforceSeenLines = options.session.enabledFeatures.enforceSeenLines
  const patcher = new Patcher({ fs, snapshots, blockResolver: nativeBlockResolver, enforceSeenLines })

  // Named registers persist across edit calls; the anonymous register is
  // batch-local. Each batch starts without anonymous state and publishes
  // named registers only after writes land — a session-register ring serves
  // as the stable clipboard for this port.
  const sessionClipboard = sessionClipboardFor(options.session)
  const clipboard = startClipboardBatch(sessionClipboard)

  // Single-section fast path: prepare, commit, render.
  const inputHash = hashPatchInput(options.input)
  if (patch.sections.length === 1) {
    const prepared = await patcher.prepare(patch.sections[0] as import('@hy-sde/dsh-hashline').PatchSection, clipboard)
    const sectionResult = await patcher.commit(prepared)
    commitClipboard(clipboard, sessionClipboard)
    if (sectionResult.op === 'noop') {
      const { count, escalate } = recordNoopEdit(options.session.sessionKey ?? {}, sectionResult.canonicalPath, inputHash)
      if (escalate) {
        throw new Error(noChangeLoopDiagnostic(sectionResult.path, count))
      }
      return { text: renderSection(sectionResult, undefined).text, sections: [renderSection(sectionResult, undefined).details] }
    }
    resetNoopEdit(options.session.sessionKey ?? {}, sectionResult.canonicalPath)
    const rendered = renderSection(sectionResult, fs.consumeDiagnostics(sectionResult.path))
    return { text: rendered.text, sections: [rendered.details] }
  }

  // Multi-section: prepare every section up front so we fail fast before
  // any write hits the filesystem. One batch-local register spans the batch,
  // so `CUT` in one section feeds a register-backed `PUT` in a later one.
  const prepared: PreparedSection[] = []
  // Register state after each section's prepare. Commits are non-atomic: a
  // mid-batch write failure leaves earlier sections on disk, so the session
  // register must reflect exactly the landed prefix.
  const sectionStates: Clipboard[] = []
  for (const section of patch.sections) {
    prepared.push(await patcher.prepare(section, clipboard))
    sectionStates.push(forkClipboard(clipboard))
  }
  assertUniqueCanonicalPaths(prepared)
  for (const entry of prepared) {
    if (entry.isNoop) {
      const { count, escalate } = recordNoopEdit(options.session.sessionKey ?? {}, entry.canonicalPath, inputHash)
      throw escalate
        ? new Error(noChangeLoopDiagnostic(entry.section.path, count))
        : new Error(noChangeDiagnostic(entry.section.path))
    }
  }
  // Then commit each one. A no-op apply mid-batch is treated as a hard
  // failure — the model authored anchors that match the current file content.
  const rendered: RenderedSection[] = []
  for (let i = 0; i < prepared.length; i++) {
    const sectionResult = await patcher.commit(prepared[i] as PreparedSection)
    commitClipboard(sectionStates[i] as Clipboard, sessionClipboard)
    if (sectionResult.op === 'noop') {
      const { count, escalate } = recordNoopEdit(options.session.sessionKey ?? {}, sectionResult.canonicalPath, inputHash)
      throw escalate
        ? new Error(noChangeLoopDiagnostic(sectionResult.path, count))
        : new Error(noChangeDiagnostic(sectionResult.path))
    }
    resetNoopEdit(options.session.sessionKey ?? {}, sectionResult.canonicalPath)
    const entry = renderSection(sectionResult, fs.consumeDiagnostics(sectionResult.path))
    rendered.push(entry)
  }

  return {
    text: rendered.map(r => r.text).join('\n\n'),
    sections: rendered.map(r => r.details),
  }
}

const clipboards = new WeakMap<object, Clipboard>()
const DEFAULT_CLIPBOARD: Clipboard = {}

/** The stable per-conversation clipboard (register) for named CUT/PUT. */
function sessionClipboardFor(session: EditSession): Clipboard {
  if (session.sessionKey !== undefined) {
    let ring = clipboards.get(session.sessionKey)
    if (ring) return ring
    ring = {}
    clipboards.set(session.sessionKey, ring)
    return ring
  }
  return DEFAULT_CLIPBOARD
}

export { HashlineMismatchError, type HashlineParams, hashlineEditParamsSchema }
