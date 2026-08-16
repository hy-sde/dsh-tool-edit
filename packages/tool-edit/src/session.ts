/**
 * Narrow `EditSession` adapter replacing oh-my-pi's giant `ToolSession` for
 * the `edit` tool port. Everything model/runtime-specific (plan-mode redirect,
 * ACP bridge, fs-cache invalidation, output artifacts) is a documented
 * no-op / identity here.
 *
 * Reads and writes go through the harness filesystem seam (`ctx.fs`): the
 * session exposes a {@link FileReader} and a {@link FileWriter} that the mode
 * executors use exclusively. Writes flow through the `fs/edit-intent`
 * waterfall and record `fs/observed`, so the fs-observation-policy layer can
 * enforce read-before-edit when mounted.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FsInfo, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { EditLspProvider } from './lsp/provider.ts'
import { createWritethrough } from './lsp/writethrough.ts'
import type { WritethroughCallback } from './lsp/writethrough.ts'

/** Modes the `edit` tool can run in (fixed by config, not per-call). */
export type EditMode = 'auto' | 'hashline' | 'replace' | 'patch' | 'apply_patch'

/** Resolved plugin configuration passed into the session factory. */
export interface ResolvedConfig {
  mode: EditMode
  fuzzyMatch: boolean
  fuzzyThreshold: number
  enforceSeenLines: boolean
  formatOnWrite: boolean
  diagnosticsOnEdit: boolean
  diagnosticsDeduplicate: boolean
  lspCommand: string
  description?: string
}

/** File reads through `ctx.fs`. */
export interface FileReader {
  /** Resolve a model-facing path to an {@link FsTarget}. */
  resolve(path: string, signal?: AbortSignal): Promise<FsTarget>
  /** Metadata probe (used to detect create-vs-update and to error helpfully). */
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  /** Full text of the target. Throws when absent. */
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
}

/** File mutations through `ctx.fs` (delete/move restricted to the cwd). */
export interface FileWriter {
  write(target: FsTarget, content: string, signal?: AbortSignal): Promise<FsVersion>
  delete(target: FsTarget, signal?: AbortSignal): Promise<void>
  move(from: FsTarget, to: FsTarget, content?: string, signal?: AbortSignal): Promise<void>
}

/** Enabled-feature flags plus the writethrough callback for mode executors. */
export interface EditSession {
  cwd: string
  /** Stable per-conversation object identity (the agent Session) for module-level state. */
  sessionKey: object | undefined
  enabledFeatures: {
    lsp: boolean
    formatOnWrite: boolean
    diagnosticsOnEdit: boolean
    diagnosticsDeduplicate: boolean
    fuzzyMatch: boolean
    fuzzyThreshold: number
    enforceSeenLines: boolean
  }
  writethrough: WritethroughCallback
  reader: FileReader
  writer: FileWriter
}

/** Creation args for {@link createEditSession}. */
export interface CreateEditSessionArgs {
  ctx: Context
  fs: FileSystem
  /** Optional embedded LSP provider for format-on-write / diagnostics. */
  provider: EditLspProvider | undefined
  config: ResolvedConfig
  exec: ToolRunContext
}

/** Path containment check used for delete/move — strictly inside `cwd`. */
export function isPathInsideCwd(candidate: string, cwd: string): boolean {
  const rel = path.relative(cwd, candidate)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * The tool working directory: prefer the agent session cwd, else the harness
 * process cwd.
 */
export function toolCwdFromExec(exec: ToolRunContext): string {
  const sessionCwd = (exec.agent?.session as { cwd?: string } | undefined)?.cwd
  if (typeof sessionCwd === 'string' && sessionCwd.length > 0) return sessionCwd
  return process.cwd()
}

/**
 * Build the {@link EditSession} closing over one tool call's execution
 * context. `exec` and `ctx` capture everything the harness owns (signal,
 * sandbox policy resolution, waterfall, emissions) per call.
 */
export function createEditSession(args: CreateEditSessionArgs): EditSession {
  const { ctx, fs, provider, config, exec } = args
  const cwd = toolCwdFromExec(exec)
  const sandboxPolicy = ctx.fs.sandboxMode === undefined ? undefined : (ctx.get('sandboxPolicy') as
    | SandboxPolicyService
    | undefined)

  const resolveSandbox = (): SandboxExecutionPolicy | undefined =>
    sandboxPolicy?.resolve({
      ...(exec.agent === undefined ? {} : { session: exec.agent.session }),
    })

  const reader: FileReader = {
    async resolve(rawPath, signal): Promise<FsTarget> {
      return fs.resolve(rawPath, signal === undefined ? { cwd } : { cwd, signal })
    },
    async stat(target, signal): Promise<FsInfo | undefined> {
      return fs.stat(target, signal)
    },
    async readText(target, signal): Promise<string> {
      return fs.readText(target, signal)
    },
  }

  const writer: FileWriter = {
    async write(target, content, signal): Promise<FsVersion> {
      // Single-slot decision: the fs-observation-policy plugin returns
      // { version: vObserved } for a read-and-confirmed target and throws
      // FS_NOT_OBSERVED / FS_NOT_FOUND otherwise; the bare default (no policy
      // mounted) yields undefined → unconditional edit. The policy's refusal
      // must propagate so the caller surfaces the read-first requirement.
      const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined as { version: FsVersion } | undefined)
      // The intent carries the observed version; writeText consumes an
      // FsWriteIntent — a replace guarded by that version (CAS).
      const expected = intent === undefined ? undefined : { kind: 'replaceIfVersion' as const, version: intent.version }
      const outcome = await fs.writeText(target, content, expected, signal, resolveSandbox())
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return outcome.version
    },
    async delete(target, signal): Promise<void> {
      // ctx.fs has no delete — this port may use node:fs/promises ONLY when
      // the resolved target stays inside the session cwd (see task spec).
      void signal
      if (!isPathInsideCwd(target.displayPath, cwd)) {
        throw new Error(`Cannot delete ${target.displayPath}: outside the working directory ${cwd}`)
      }
      await fsp.rm(target.displayPath, { force: false })
    },
    async move(from, to, content, signal): Promise<void> {
      // Write-through move: probe existence at destination first (non-overwriting).
      const destInfo = await fs.stat(to, signal)
      if (destInfo !== undefined) {
        throw new Error(`Cannot move ${from.displayPath} to ${to.displayPath}: destination already exists.`)
      }
      if (content !== undefined) {
        await this.write(to, content, signal)
        await this.delete(from, signal)
        return
      }
      if (!isPathInsideCwd(from.displayPath, cwd) || !isPathInsideCwd(to.displayPath, cwd)) {
        throw new Error(`Cannot move ${from.displayPath} to ${to.displayPath}: outside the working directory ${cwd}`)
      }
      await fsp.rename(from.displayPath, to.displayPath)
    },
  }

  return {
    cwd,
    sessionKey: exec.agent?.session,
    enabledFeatures: {
      lsp: provider !== undefined,
      formatOnWrite: config.formatOnWrite && provider !== undefined,
      diagnosticsOnEdit: config.diagnosticsOnEdit && provider !== undefined,
      diagnosticsDeduplicate: config.diagnosticsDeduplicate,
      fuzzyMatch: config.fuzzyMatch,
      fuzzyThreshold: config.fuzzyThreshold,
      enforceSeenLines: config.enforceSeenLines,
    },
    writethrough: createWritethrough({ provider, config }),
    reader,
    writer,
  }
}
