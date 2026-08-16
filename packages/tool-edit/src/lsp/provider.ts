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
 * @module @hy-sde/dsh-tool-edit/lsp
 */

import { TextDocumentLspClient, type EditLspDiagnostic } from './client.ts'
import { pathToUri } from './client.ts'
import { languageIdFromPath } from './client.ts'

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
}

/**
 * Create the provider. The server is spawned lazily on the first actual
 * format/diagnostics call, so sessions that never write through LSP pay
 * nothing. `dispose` is idempotent and safe to call at plugin teardown.
 */
export function createEditLspProvider(options?: EditLspProviderOptions): EditLspProvider {
  const command = options?.command ?? DEFAULT_LSP_COMMAND
  // A shared client keeps one server process across the plugin lifetime; a
  // per-call client would re-pay ~1-2s server boot per edit.
  const client = new TextDocumentLspClient(command, options?.cwd)

  const provider: EditLspProvider = {
    async format(args, signal): Promise<EditLspFormatResult | undefined> {
      if (signal?.aborted) return undefined
      const uri = pathToUri(args.filePath)
      const languageId = languageIdFromPath(args.filePath)
      const formattedText = await client.format(uri, languageId, args.text)
      // `undefined` marks unavailability; `null` means "no formatting edits".
      if (formattedText === undefined) return undefined
      return { formattedText }
    },
    async collectDiagnostics(args, signal): Promise<EditLspDiagnosticsResult | undefined> {
      if (signal?.aborted) return undefined
      const uri = pathToUri(args.filePath)
      const languageId = languageIdFromPath(args.filePath)
      const diagnostics = await client.collectDiagnostics(uri, languageId, args.text)
      if (diagnostics === undefined) return undefined
      return { diagnostics }
    },
    async dispose(): Promise<void> {
      await client.dispose()
    },
  }
  return provider
}

export { pathToUri, languageIdFromPath }
export type { EditLspDiagnostic }
