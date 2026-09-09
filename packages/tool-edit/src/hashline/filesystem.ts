/**
 * Coding-agent specific {@link Filesystem} adapter for the hashline patcher —
 * a thin port of oh-my-pi's `HashlineFilesystem` wired to the harness seam.
 *
 * Differences from the original (all documented here rather than silently):
 * - Reads resolve via the session reader (ctx.fs) and any successful read is
 *   recorded into the session snapshot store, so a tag minted on a read can
 *   anchor a later edit without a separate read pipeline.
 * - Writes flow through the session writer = ctx.fs + fs/edit-intent +
 *   fs/observed, then the LSP writethrough happens FIRST via the session's
 *   writethrough callback so formatting applies and diagnostics latch.
 * - Delete/move go through the session writer, which confines node:fs
 *   usage to targets inside the session cwd (matched path recovery is
 *   confined to the cwd as well).
 * - Plan-mode redirect and ACP bridge are not ported (no-ops).
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import * as path from 'node:path'
import {
  Filesystem,
  NotFoundError,
  type PreflightWriteOptions,
  type WriteResult,
} from '@hy-sde-org/dsh-hashline'
import { isPathInsideCwd } from '../session.ts'
import type { EditDiagnosticsResult } from '../lsp/writethrough.ts'
import type { EditSession, FileReader } from '../session.ts'
import type { SnapshotStore } from '@hy-sde-org/dsh-hashline'

export interface HashlineFilesystemOptions {
  session: EditSession
  snapshots: SnapshotStore
  signal?: AbortSignal
}

/**
 * Map an authored hashline path to the absolute path the harness resolves.
 * hashline paths after `Patch.parse(..., {cwd})` are already absolute, but
 * the adapter stays defensive via the reader.
 */
function toFsTarget(reader: FileReader, rawPath: string, signal?: AbortSignal): Promise<import('@deepseek-ai/dsh-fs').FsTarget> {
  return reader.resolve(rawPath, signal)
}

export class EditFilesystem extends Filesystem {
  readonly session: EditSession
  readonly #snapshots: SnapshotStore
  readonly #signal: AbortSignal | undefined
  #diagnosticsByPath = new Map<string, EditDiagnosticsResult | undefined>()

  constructor(options: HashlineFilesystemOptions) {
    super()
    this.session = options.session
    this.#snapshots = options.snapshots
    this.#signal = options.signal
  }

  /**
   * Look up (and clear) the diagnostics captured by the most-recent
   * {@link writeText} call for `path`. Returns `undefined` if the writethrough
   * returned no diagnostics.
   */
  consumeDiagnostics(path: string): EditDiagnosticsResult | undefined {
    const value = this.#diagnosticsByPath.get(path)
    this.#diagnosticsByPath.delete(path)
    return value
  }

  override canonicalPath(relativePath: string): string {
    return path.resolve(this.session.cwd, relativePath)
  }

  override allowTagPathRecovery(_authoredPath: string, resolvedPath: string): boolean {
    // Confine tag-based path recovery to the working tree: a snapshot tag
    // should never redirect an edit outside the session cwd.
    return isPathInsideCwd(resolvedPath, this.session.cwd)
  }

  async readText(relativePath: string): Promise<string> {
    const target = await toFsTarget(this.session.reader, relativePath, this.#signal)
    let content: string
    try {
      content = await this.session.reader.readText(target, this.#signal)
    } catch (error) {
      if (isNotFound(error)) throw new NotFoundError(relativePath, error)
      throw error
    }
    // Mint/merge a snapshot so the tag the model saw (or will see) resolves.
    this.#snapshots.record(this.canonicalPath(relativePath), normalizeSnapshotText(content))
    return content
  }

  override async preflightWrite(_relativePath: string, _options?: PreflightWriteOptions): Promise<void> {
    // No plan-mode guard in the harness port; the writer's intent/observed
    // flow governs permissions at write time.
  }

  override async delete(relativePath: string): Promise<void> {
    const target = await toFsTarget(this.session.reader, relativePath, this.#signal)
    await this.session.writer.delete(target, this.#signal)
  }

  override async move(fromRelative: string, toRelative: string, content?: string): Promise<void> {
    const fromTarget = await toFsTarget(this.session.reader, fromRelative, this.#signal)
    const toTarget = await toFsTarget(this.session.reader, toRelative, this.#signal)
    await this.session.writer.move(fromTarget, toTarget, content, this.#signal)
  }

  async writeText(relativePath: string, content: string): Promise<WriteResult> {
    const target = await toFsTarget(this.session.reader, relativePath, this.#signal)
    let finalContent = content
    let diagnostics: EditDiagnosticsResult | undefined
    try {
      const result = await this.session.writethrough(target.displayPath, content, this.#signal)
      if (result !== undefined) {
        diagnostics = result
        finalContent = content // writethrough reports formatting; keep authored view
      }
    } catch {
      // writethrough must never block a write
    }
    await this.session.writer.write(target, finalContent, this.#signal)
    this.#diagnosticsByPath.set(relativePath, diagnostics)
    return { text: content }
  }

  override async exists(relativePath: string): Promise<boolean> {
    const target = await toFsTarget(this.session.reader, relativePath, this.#signal)
    return (await this.session.reader.stat(target, this.#signal)) !== undefined
  }
}

/** Check whether an error is a hashline NotFoundError or fs-seam ENOENT-family error. */
function isNotFound(error: unknown): boolean {
  if (error instanceof NotFoundError) return true
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    if (code === 'ENOENT') return true
    // dsh-fs surfaces FsError with FS_NOT_FOUND; hashline's patcher treats
    // only NotFoundError-or-ENOENT as "missing", so translate it.
    if (code === 'FS_NOT_FOUND') return true
  }
  return false
}

/** LF-normalized, BOM-stripped text for snapshot storage (matches patcher's read convention). */
function normalizeSnapshotText(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}
