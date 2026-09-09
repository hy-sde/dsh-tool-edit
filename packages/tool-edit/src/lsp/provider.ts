/**
 * The `EditLspProvider` facade: the one object the edit tool talks to for
 * format-on-write and diagnostics-on-edit. This replaces the harness's
 * `ctx.lsp` seam dependency in the standalone plugin — everything is
 * self-contained here, so stock DeepSeek Harness deployments get full LSP
 * behavior with no upstream changes.
 *
 * Degradation contract: every method resolves `undefined` instead of throwing
 * when the language server is unavailable, disabled, or failed. The
 * writethrough layer already treats `undefined` as pass-through.
 * @module @hy-sde-org/dsh-tool-edit/lsp
 */

import { TextDocumentLspClient, type EditLspDiagnostic } from './client.ts'
import { pathToUri } from './client.ts'
import { languageIdFromPath } from './client.ts'
import { splitCommand } from './stdio.ts'
import {
  resolveTscOnPath,
  selectTypeScriptServer,
  type TypeScriptNativeConfig,
} from './typescript.ts'

/** Default language-server command (installed on demand by npx). */
export const DEFAULT_LSP_COMMAND = 'npx --yes typescript-language-server --stdio'

/** Formatting request surface (mirrors the removed seam argument shapes). */
export interface EditLspFormatArgs {
  filePath: string
  workspaceRoot: string
  text: string
}

/** Result: `formattedText` is `null` when the server has no formatting edits. */
export interface EditLspFormatResult {
  formattedText: string | null
}

/** Diagnostics request surface. */
export interface EditLspDiagnosticsArgs {
  filePath: string
  workspaceRoot: string
  text: string
  version: number
}

/** Diagnostics payload merged into an edit result. */
export interface EditLspDiagnosticsResult {
  diagnostics: readonly EditLspDiagnostic[]
}

/** The writethrough-facing surface of the embedded language server. */
export interface EditLspProvider {
  format(args: EditLspFormatArgs, signal?: AbortSignal): Promise<EditLspFormatResult | undefined>
  collectDiagnostics(
    args: EditLspDiagnosticsArgs,
    signal?: AbortSignal,
  ): Promise<EditLspDiagnosticsResult | undefined>
  dispose(): Promise<void>
}

/** Creation options for {@link createEditLspProvider}. */
export interface EditLspProviderOptions {
  /** Server command line; see {@link DEFAULT_LSP_COMMAND}. */
  command?: string
  /** Spawn working directory (the edit session cwd keeps files in scope). */
  cwd?: string
  /**
   * Opt into per-workspace TypeScript server selection (upstream oh-my-pi
   * commit 530664c8f5): TypeScript 7 dropped the JS `lib/tsserver.js` that
   * `typescript-language-server` wraps and speaks LSP natively via
   * `tsc --lsp --stdio`, so a workspace whose TypeScript install has no
   * `lib/tsserver.js` spawns the workspace's own `tsc` (falling back to the
   * resolved `tsc` on PATH) with `--lsp --stdio`, and every other workspace
   * keeps the configured `command`. Absent = disabled (default, off).
   */
  typescriptNative?: TypeScriptNativeConfig
}

/**
 * Create the provider. The server is spawned lazily on the first actual
 * format/diagnostics call, so sessions that never write through LSP pay
 * nothing. `dispose` is idempotent and safe to call at plugin teardown.
 *
 * With {@link EditLspProviderOptions.typescriptNative} set, the spawn command
 * is selected per workspace on first use (the call's `workspaceRoot`), then
 * memoized: one client (one server process) serves the provider lifetime.
 */
export function createEditLspProvider(options?: EditLspProviderOptions): EditLspProvider {
  const command = options?.command ?? DEFAULT_LSP_COMMAND
  const typescriptNative = options?.typescriptNative
  if (typescriptNative !== undefined && (typescriptNative.command ?? 'tsc').trim() === '') {
    throw new Error('tool-edit: typescriptNative.command must be non-empty')
  }
  // The PATH native launcher is resolved once at creation (upstream
  // 530664c8f5 resolves it at config load); selection only uses it when no
  // workspace-local TypeScript install decides.
  const resolvedTsc = typescriptNative === undefined ? null : resolveTscOnPath(typescriptNative.command ?? 'tsc')
  // A shared client keeps one server process across the plugin lifetime; a
  // per-call client would re-pay ~1-2s server boot per edit.
  let client: TextDocumentLspClient | undefined
  const clientFor = (workspaceRoot: string): TextDocumentLspClient => {
    if (client === undefined) {
      if (typescriptNative === undefined) {
        client = new TextDocumentLspClient(command, options?.cwd)
      } else {
        const selection = selectTypeScriptServer(
          { command, args: splitCommand(command), typescriptNative },
          workspaceRoot,
          resolvedTsc,
        )
        client = new TextDocumentLspClient(
          // The client splits a command line at spawn; re-join the selected
          // argv (no quoted arguments in these commands, the documented
          // constraint).
          [selection.command, ...selection.args].join(' '),
          // The native `tsc --lsp` discovers the project from its cwd, so the
          // selected workspace root doubles as the spawn cwd; an explicit
          // `cwd` option wins.
          options?.cwd ?? workspaceRoot,
        )
      }
    }
    return client
  }

  const provider: EditLspProvider = {
    async format(args, signal): Promise<EditLspFormatResult | undefined> {
      if (signal?.aborted) return undefined
      const uri = pathToUri(args.filePath)
      const languageId = languageIdFromPath(args.filePath)
      const formattedText = await clientFor(args.workspaceRoot).format(uri, languageId, args.text)
      // `undefined` marks unavailability; `null` means "no formatting edits".
      if (formattedText === undefined) return undefined
      return { formattedText }
    },
    async collectDiagnostics(args, signal): Promise<EditLspDiagnosticsResult | undefined> {
      if (signal?.aborted) return undefined
      const uri = pathToUri(args.filePath)
      const languageId = languageIdFromPath(args.filePath)
      const diagnostics = await clientFor(args.workspaceRoot).collectDiagnostics(uri, languageId, args.text)
      if (diagnostics === undefined) return undefined
      return { diagnostics }
    },
    async dispose(): Promise<void> {
      if (client !== undefined) await client.dispose()
    },
  }
  return provider
}

export { pathToUri, languageIdFromPath }
export type { EditLspDiagnostic, TypeScriptNativeConfig }
