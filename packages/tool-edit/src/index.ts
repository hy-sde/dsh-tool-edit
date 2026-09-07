/**
 * `edit` — the oh-my-pi coding-agent edit tool ported onto the harness
 * filesystem seam (`ctx.fs`), with all four modes (replace / patch /
 * apply_patch / hashline). The mode is fixed by configuration, not per call;
 * the appropriate argument shape is validated by field presence inside
 * {@link dispatchMode}.
 *
 * Reading before editing: every mode reads through `ctx.fs`; writes flow
 * through the `fs/edit-intent` waterfall and record `fs/observed`, so the
 * fs-observation-policy (when mounted) can require the file be read first.
 * See {@link createEditSession}.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import {
  APPLY_PATCH_SCHEMA_DESCRIPTIONS,
  EDIT_TOOL_DESCRIPTION,
  HASHLINE_SCHEMA_DESCRIPTIONS,
  PATCH_SCHEMA_DESCRIPTIONS,
  REPLACE_SCHEMA_DESCRIPTIONS,
} from './constants.ts'
import { fileDiffsFromMeta, type FileDiff } from './details.ts'
import { ApplyPatchError } from './diff.ts'
import { containsRecognizableHashlineOperations } from '@hy-sde-org/dsh-hashline'
import { executeHashlineSingle } from './hashline/execute.ts'
import { executePatchEntry, type PatchEditEntry } from './patch.ts'
import { expandApplyPatchToEntries } from './apply-patch.ts'
import { executeReplace } from './replace.ts'
import { createEditSession, type EditMode, type EditSession, type ResolvedConfig } from './session.ts'
import { DEFAULT_LSP_COMMAND, createEditLspProvider, type EditLspProvider } from './lsp/provider.ts'
import type { TypeScriptNativeConfig } from './lsp/provider.ts'

export const name = 'tool-edit'
export const inject = ['tools', 'fs', 'systemPrompt'] as const

/** Runtime configuration for the `edit` tool. */
export interface Config {
  /** Which mode the single `edit` tool runs (default 'hashline': line-anchored patches). */
  mode?: EditMode
  /** Whether fuzzy whitespace matching is allowed (replace/patch). */
  fuzzyMatch?: boolean
  /** Similarity threshold for fuzzy matches (0..1). */
  fuzzyThreshold?: number
  /** hashline: reject edits on lines the model never saw. */
  enforceSeenLines?: boolean
  /** LSP-write through: format the file with the formatter on write. */
  formatOnWrite?: boolean
  /** LSP-write through: collect diagnostics after a successful write. */
  diagnosticsOnEdit?: boolean
  /** Deduplicate diagnostics by message (applies when diagnosticsOnEdit). */
  diagnosticsDeduplicate?: boolean
  /** Language-server command line; default spins up typescript-language-server on demand. */
  lspCommand?: string
  /**
   * Opt into per-workspace TypeScript server selection (upstream oh-my-pi
   * commit 530664c8f5): a workspace whose TypeScript install has no
   * `lib/tsserver.js` (TypeScript 7+) spawns the native `tsc --lsp --stdio`
   * and every other workspace keeps `lspCommand`. Off unless set.
   */
  typescriptNative?: TypeScriptNativeConfig
  /** Override the model-facing tool description. */
  description?: string
}

/** Runtime configuration schema for the `edit` tool. */
export const Config: z<Config> = z.object({
  mode: z.union(['auto', 'hashline', 'replace', 'patch', 'apply_patch'] as const).default('hashline'),
  fuzzyMatch: z.boolean().default(true),
  fuzzyThreshold: z.number().default(0.95),
  enforceSeenLines: z.boolean().default(false),
  formatOnWrite: z.boolean().default(false),
  diagnosticsOnEdit: z.boolean().default(false),
  diagnosticsDeduplicate: z.boolean().default(true),
  lspCommand: z.string().default(DEFAULT_LSP_COMMAND),
  typescriptNative: z.object({ command: z.string().default('tsc') }),
  description: z.string(),
})

/** Resolve the schema defaults into the runtime config handed to sessions. */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    mode: config.mode ?? 'hashline',
    fuzzyMatch: config.fuzzyMatch ?? true,
    fuzzyThreshold: config.fuzzyThreshold ?? 0.95,
    enforceSeenLines: config.enforceSeenLines ?? false,
    formatOnWrite: config.formatOnWrite ?? false,
    diagnosticsOnEdit: config.diagnosticsOnEdit ?? false,
    diagnosticsDeduplicate: config.diagnosticsDeduplicate ?? true,
    lspCommand: config.lspCommand ?? DEFAULT_LSP_COMMAND,
    ...config.typescriptNative === undefined ? {} : { typescriptNative: config.typescriptNative },
    ...config.description === undefined ? {} : { description: config.description },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Mode dispatch
// ═══════════════════════════════════════════════════════════════════════════

/** Discriminate the mode from the call args (field-presence heuristic). */
export function dispatchMode(resolved: ResolvedConfig, args: Record<string, unknown>): EditMode {
  const hasOldString = typeof args.old_string === 'string'
  const hasEdits = Array.isArray(args.edits)
  const hasInput = typeof args.input === 'string'

  if (hasOldString) return 'replace'
  if (hasEdits) return 'patch'
  if (!hasInput) {
    throw new Error(
      'No recognized edit payload: expected replace mode args (path + old_string + new_string), ' +
      'patch mode args (path + edits), or apply_patch / hashline mode args (input).',
    )
  }

  // `input` payload: fixed by configuration when explicit, else sniffed.
  if (resolved.mode === 'hashline') return 'hashline'
  if (resolved.mode === 'apply_patch' || resolved.mode === 'replace' || resolved.mode === 'patch') {
    return 'apply_patch'
  }
  return containsRecognizableHashlineOperations(args.input as string) ? 'hashline' : 'apply_patch'
}

// ═══════════════════════════════════════════════════════════════════════════
// Presentation
// ═══════════════════════════════════════════════════════════════════════════

/** Best-effort lead path from an `input` payload for presentCall/Result. */
function leadPathFromInput(input: string): string {
  const match = /^\[\s*([^#\]]+)/mu.exec(input.trim())
  if (match && match[1]) return match[1].trim()
  const patchMatch = /^\*\*\*\s*\S+\s+File:\s+(.+)$/mu.exec(input.trim())
  if (patchMatch && patchMatch[1]) return patchMatch[1].trim()
  return ''
}

function presentCall(args: Record<string, unknown>, resolved: ResolvedConfig): ToolCallView {
  const mode = dispatchMode(resolved, args)
  const path = resolvePathArg(args) ?? leadPathFromInput(typeof args.input === 'string' ? args.input : '')
  if (mode === 'replace') {
    return {
      card: 'diff',
      title: `Edit ${path}`,
      diffs: buildReplaceDiffs(
        path,
        typeof args.old_string === 'string' ? args.old_string : '',
        typeof args.new_string === 'string' ? args.new_string : '',
      ),
      locations: [{ path }],
    }
  }
  return {
    card: 'generic',
    title: `edit ${path}`,
    kind: 'edit',
    ...(path.length > 0 ? { locations: [{ path }] } : {}),
  }
}

function presentResult(_args: Record<string, unknown>, result: unknown, _resolved: ResolvedConfig): ToolResultView | undefined {
  const diffs = fileDiffsFromMeta((result as { meta?: unknown } | undefined)?.meta)
  if (diffs !== undefined && diffs.length > 0) {
    return { card: 'diff', title: `Edit ${diffs[0]?.path ?? ''}`, diffs }
  }
  return undefined
}

// ═══════════════════════════════════════════════════════════════════════════
// Execution
// ═══════════════════════════════════════════════════════════════════════════

/** Minimal per-call execution context threaded into the session factory. */
interface ToolRunExec {
  signal?: AbortSignal
  agent?: { session?: { cwd?: string } }
  /** The plugin-scoped embedded LSP provider installed at mount time. */
  provider?: EditLspProvider
}

/** Read the per-call execution context stashed by {@link registerEditTool}. */
function toolExecFor(ctx: Context): ToolRunExec {
  return (ctx as unknown as Record<string, unknown>)['__toolEditExec'] as ToolRunExec
}

function buildSession(ctx: Context, resolved: ResolvedConfig, exec: ToolRunExec): EditSession {
  const fs = ctx.fs as FileSystem
  return createEditSession({ ctx, fs, provider: exec.provider, config: resolved, exec: exec as never })
}

/** Execute the replace mode (mode 'replace'). */
async function runReplace(ctx: Context, resolved: ResolvedConfig, args: Record<string, unknown>): Promise<string> {
  const path = requirePath(args)
  const old_string = requireString(args.old_string, 'old_string')
  const new_string = typeof args.new_string === 'string' ? args.new_string : ''
  const replace_all = args.replace_all === true
  const exec = toolExecFor(ctx)
  const session = buildSession(ctx, resolved, exec)
  const outcome = await executeReplace({
    session,
    path,
    params: { old_string, new_string, replace_all },
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
    allowFuzzy: resolved.fuzzyMatch,
    fuzzyThreshold: resolved.fuzzyThreshold,
    writethrough: session.writethrough,
  })
  return outcome.text
}

/** Execute mode 'patch' (JSON patch entries). */
async function runPatch(ctx: Context, resolved: ResolvedConfig, args: Record<string, unknown>): Promise<string> {
  const path = requirePath(args)
  const edits = requireArray(args.edits, 'edits') as PatchEditEntry[]
  const exec = toolExecFor(ctx)
  const session = buildSession(ctx, resolved, exec)
  return executeEdits(session, path, edits, exec.signal, resolved)
}

/** Execute mode 'apply_patch' (Codex envelope). */
async function runApplyPatch(ctx: Context, resolved: ResolvedConfig, args: Record<string, unknown>): Promise<string> {
  const input = requireString(args.input, 'input')
  const exec = toolExecFor(ctx)
  const session = buildSession(ctx, resolved, exec)
  const entries = expandApplyPatchToEntries({ input })
  const lines: string[] = []
  for (const entry of entries) {
    const outcome = await executePatchEntry({
      session,
      path: entry.path,
      params: {
        ...(entry.op === undefined ? {} : { op: entry.op }),
        ...(entry.rename === undefined ? {} : { rename: entry.rename }),
        ...(entry.diff === undefined ? {} : { diff: entry.diff }),
      },
      ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      allowFuzzy: resolved.fuzzyMatch,
      fuzzyThreshold: resolved.fuzzyThreshold,
      allowCreateOverwrite: false,
    })
    lines.push(outcome.text)
  }
  return lines.join('\n')
}

/** Execute mode 'hashline' (line-anchored patch language). */
async function runHashline(ctx: Context, resolved: ResolvedConfig, args: Record<string, unknown>): Promise<string> {
  const input = requireString(args.input, 'input')
  const exec = toolExecFor(ctx)
  const session = buildSession(ctx, resolved, exec)
  const outcome = await executeHashlineSingle({
    session,
    input,
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  })
  return outcome.text
}

/** Execute a list of patch entries (mode 'patch'), aggregating text. */
async function executeEdits(
  session: EditSession,
  path: string,
  edits: PatchEditEntry[],
  signal: AbortSignal | undefined,
  resolved: ResolvedConfig,
): Promise<string> {
  const lines: string[] = []
  for (const entry of edits) {
    const outcome = await executePatchEntry({
      session,
      path,
      params: entry,
      ...(signal === undefined ? {} : { signal }),
      allowFuzzy: resolved.fuzzyMatch,
      fuzzyThreshold: resolved.fuzzyThreshold,
      allowCreateOverwrite: true,
    })
    lines.push(outcome.text)
  }
  return lines.join('\n')
}

/** Build the replace-args diff card data (old→new). */
function buildReplaceDiffs(path: string, old_string: string, new_string: string): FileDiff[] {
  return [{ path, oldText: old_string.length > 0 ? old_string : null, newText: new_string }]
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new Error(`Parameter \`${key}\` is required and must be a string`)
  return value
}

function requireArray(value: unknown, key: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Parameter \`${key}\` is required and must be an array`)
  return value
}

/**
 * The path argument with the legacy aliases models send as often as `path`:
 * `file_path` (harness fs surface) and `filePath` (camelCase habit). Missing
 * yields `undefined` so {@link requirePath} reports the canonical name.
 */
export function resolvePathArg(args: Record<string, unknown>): string | undefined {
  if (typeof args.path === 'string') return args.path
  if (typeof args.file_path === 'string') return args.file_path
  if (typeof args.filePath === 'string') return args.filePath
  return undefined
}

/** Like {@link requireString}, but for the path argument and its aliases. */
function requirePath(args: Record<string, unknown>): string {
  const value = resolvePathArg(args)
  if (value === undefined) throw new Error('Parameter `path` is required and must be a string')
  return value
}

/** Whether an error is the fs layer's concurrent-mutation refusal. */
export function isStaleVersionError(error: unknown): boolean {
  if (error instanceof FsError) return error.code === 'FS_STALE_VERSION'
  return error instanceof Error && error.message.includes('FS_STALE_VERSION')
}

/**
 * Register the `edit` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param config - resolved runtime configuration.
 */
function registerEditTool(ctx: Context, config: ResolvedConfig, provider: EditLspProvider | undefined): void {
  const description = config.description ?? EDIT_TOOL_DESCRIPTION

  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: 102,
    text: 'Use the edit tool for targeted changes to existing UTF-8 text files. ' +
      'Read the file first to get its [path#tag] header and line numbers for hashline anchors; ' +
      'the tool verifies anchors against that tagged content, applies atomically, and its own reads ' +
      'satisfy the fs-observation-policy guard in this session. ' +
      'The tool runs in a fixed mode (see its description); call it with the argument shape for that mode.',
  })

  ctx.tools.register(defineTool({
    name: 'edit',
    description,
    parameters: {
      path: { type: 'string', description: REPLACE_SCHEMA_DESCRIPTIONS.path },
      file_path: { type: 'string', description: 'Alias for `path`; prefer `path`.' },
      filePath: { type: 'string', description: 'Alias for `path`; prefer `path`.' },
      old_string: { type: 'string', description: REPLACE_SCHEMA_DESCRIPTIONS.old_string },
      new_string: { type: 'string', description: REPLACE_SCHEMA_DESCRIPTIONS.new_string },
      replace_all: { type: 'boolean', description: REPLACE_SCHEMA_DESCRIPTIONS.replace_all },
      edits: { type: 'array', description: PATCH_SCHEMA_DESCRIPTIONS.edits },
      input: { type: 'string', description: `${APPLY_PATCH_SCHEMA_DESCRIPTIONS.input}. ${HASHLINE_SCHEMA_DESCRIPTIONS.input}` },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
      // Diff-card metadata projected purely from the call args (replace mode
      // carries old/new snapshots itself); patch/apply_patch/hashline diffs are
      // not derivable from a string output, so they fall back to the generic card.
      presentationMeta: (args) => {
        const resolved = resolveConfig(config)
        if (dispatchMode(resolved, args as Record<string, unknown>) !== 'replace') return {}
        const raw = args as Record<string, unknown>
        const path = resolvePathArg(raw) ?? ''
        const old_string = typeof raw.old_string === 'string' ? raw.old_string : ''
        const new_string = typeof raw.new_string === 'string' ? raw.new_string : ''
        const diffs = buildReplaceDiffs(path, old_string, new_string).map(
          diff => ({ path: diff.path, oldText: diff.oldText, newText: diff.newText }),
        )
        return { diffs }
      },
    },
    async execute(args, exec) {
      const resolved = resolveConfig(config)
      const ctxFor = ctx as unknown as Record<string, unknown>
      ctxFor['__toolEditExec'] = {
        signal: exec.signal,
        ...exec.agent === undefined ? {} : { agent: { session: exec.agent.session } },
        ...provider === undefined ? {} : { provider },
      }
      try {
        const mode = dispatchMode(resolved, args as Record<string, unknown>)
        const record = args as Record<string, unknown>
        const run = (): Promise<string> => {
          switch (mode) {
            case 'replace':
              return runReplace(ctx, resolved, record)
            case 'patch':
              return runPatch(ctx, resolved, record)
            case 'apply_patch':
              return runApplyPatch(ctx, resolved, record)
            case 'hashline':
              return runHashline(ctx, resolved, record)
            default:
              return Promise.reject(new Error(`tool-edit: unknown mode ${mode}`))
          }
        }
        try {
          return await run()
        } catch (error) {
          // A concurrent mutation between the executor's read and its guarded
          // write aborts the WHOLE edit before anything lands (the write is
          // the single side effect), so re-running once is safe for replace
          // mode: the fresh session re-reads, re-observes the current version,
          // and re-applies the same anchored edit. Multi-entry patch / hashline
          // batches are NOT retried — an earlier entry may already be on disk.
          if (mode === 'replace' && isStaleVersionError(error)) return await run()
          throw error
        }
      } catch (error) {
        if (error instanceof ApplyPatchError) throw new Error(errorMessage(error))
        const message = errorMessage(error)
        // A no-op edit (old === new, or the patch resolves to the current
        // content) is a SUCCESS: the intended state already holds. Report it
        // instead of surfacing an error the model would retry against.
        if (/resulted in no changes being made|old_string and new_string must differ/.test(message)) {
          return `No change: ${message}`
        }
        throw error
      } finally {
        ctxFor['__toolEditExec'] = undefined
      }
    },
    presentCall: args => presentCall(args as Record<string, unknown>, resolveConfig(config)),
    presentResult: (args, result) =>
      presentResult(args as Record<string, unknown>, result, resolveConfig(config)),
  }))
}

/** Summarize errors into stable model-facing messages. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Mount the plugin: config validation, system prompt, and the single tool. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (!Number.isFinite(resolved.fuzzyThreshold) || resolved.fuzzyThreshold <= 0 || resolved.fuzzyThreshold > 1) {
    throw new Error('tool-edit: fuzzyThreshold must be in (0, 1]')
  }
  // The embedded LSP provider is created lazily on first use and torn down
  // with the plugin, so format/diagnostics cost nothing on sessions that
  // never write through LSP.
  const provider = createEditLspProvider({
    command: resolved.lspCommand,
    ...resolved.typescriptNative === undefined ? {} : { typescriptNative: resolved.typescriptNative },
  })
  ctx.effect(() => () => { void provider.dispose() })
  registerEditTool(ctx, resolved, provider)
}
