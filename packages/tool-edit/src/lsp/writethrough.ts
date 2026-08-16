/**
 * Thin port of oh-my-pi's `createLspWritethrough` (lsp/writethrough.ts +
 * diagnostic formatting from lsp/utils.ts) onto the plugin's embedded LSP
 * provider (`./provider.ts`), a self-contained language-server client. The
 * original's batch machinery is preserved only in essence: a batch id plus a
 * flush flag merging deferred diagnostics across writes within one tool call
 * via an in-memory ledger per writethrough session (keyed by the callback
 * identity via closure state), mirroring the batch argument surface.
 *
 * Note on the degraded path: the original called `lsp.format` /
 * `lsp.collectDiagnostics` on its own LSP client; the embedded provider either
 * serves the same calls or resolves `undefined` when its server is
 * unavailable, so formatting/diagnostics degrade to pass-through.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import type { ResolvedConfig } from '../session.ts'
import type { EditLspDiagnostic, EditLspProvider } from './provider.ts'

/** Diagnostics payload attached to an edit result. */
export interface EditDiagnosticsResult {
  summary: string
  messages: readonly EditLspDiagnostic[]
}

/** Cap on surfaced diagnostic messages (from the original's limit). */
const DIAGNOSTIC_MESSAGE_LIMIT = 50

/** Truncate a message list to {@link DIAGNOSTIC_MESSAGE_LIMIT}. */
export function limitDiagnosticMessages(messages: readonly EditLspDiagnostic[]): readonly EditLspDiagnostic[] {
  return messages.length <= DIAGNOSTIC_MESSAGE_LIMIT ? messages : messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT)
}

/**
 * Summarize diagnostics into a severity-count summary line (ported from
 * `summarizeDiagnosticMessages` / `formatDiagnosticsSummary`).
 */
export function summarizeDiagnostics(diagnostics: readonly EditLspDiagnostic[]): string {
  const counts = { error: 0, warning: 0, info: 0, hint: 0 }
  for (const diagnostic of diagnostics) {
    switch (diagnostic.severity) {
      case 1:
        counts.error++
        break
      case 2:
        counts.warning++
        break
      case 3:
        counts.info++
        break
      case 4:
        counts.hint++
        break
      default:
        break
    }
  }
  const parts: string[] = []
  if (counts.error > 0) parts.push(`${counts.error} error(s)`)
  if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`)
  if (counts.info > 0) parts.push(`${counts.info} info(s)`)
  if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`)
  return parts.length > 0 ? parts.join(', ') : 'no issues'
}

/** Format one diagnostic as `line:col [severity] source(message)`. */
export function formatDiagnosticMessage(diagnostic: EditLspDiagnostic): string {
  const severity = diagnostic.severity === 1 ? 'error'
    : diagnostic.severity === 2 ? 'warning'
      : diagnostic.severity === 3 ? 'info'
        : diagnostic.severity === 4 ? 'hint'
          : 'unknown'
  const source = diagnostic.source ? `[${diagnostic.source}] ` : ''
  const message = diagnostic.message.trim()
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1
  return `${line}:${col} [${severity}] ${source}${message}`
}

/** Optional per-batch metadata merged across writes within one tool call. */
export interface WritethroughBatch {
  id: string
  flush: boolean
}

/**
 * The write-through callback used by every edit mode: format-on-write via the
 * LSP provider, then optional diagnostics. `signal` aborts the LSP calls;
 * `batch` merges deferred diagnostics within a tool call. Never throws on
 * LSP failure — formatting/diagnostics degrade to pass-through.
 */
export type WritethroughCallback = (
  dst: string,
  content: string,
  signal?: AbortSignal,
  batch?: WritethroughBatch,
) => Promise<EditDiagnosticsResult | undefined>

/** Deduplicate diagnostics that differ only by version (same line/col/message). */
function deduplicateDiagnostics(diagnostics: readonly EditLspDiagnostic[]): readonly EditLspDiagnostic[] {
  const seen = new Set<string>()
  const kept: EditLspDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}|${diagnostic.severity ?? 0}|${diagnostic.message}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(diagnostic)
  }
  return kept
}

/** Serialize the diagnostics payload into the model-facing result text. */
export function renderDiagnosticsSummary(result: EditDiagnosticsResult | undefined): string {
  if (!result) return ''
  const messageLines = result.messages.map(formatDiagnosticMessage)
  const body = messageLines.length > 0 ? messageLines.join('\n') : ''
  return [result.summary, body].filter(part => part.length > 0).join('\n')
}

/** Build a DiagnosticsResult from the provider response plus dedupe/config. */
function toDiagnosticsResult(
  diagnostics: readonly EditLspDiagnostic[],
  deduplicate: boolean,
): EditDiagnosticsResult {
  const messages = limitDiagnosticMessages(deduplicate ? deduplicateDiagnostics(diagnostics) : diagnostics)
  return { summary: summarizeDiagnostics(messages), messages }
}

/**
 * Build the writethrough callback for one edit tool call.
 *
 * The embedded provider's `format`/`collectDiagnostics` accept an AbortSignal,
 * so the batch-shaped surface of the original is adapted to a per-callback
 * ledger: each distinct callback (per session) tracks its own version counter
 * and pending batch diagnostics keyed by batch id.
 */
export function createWritethrough(options: { provider: EditLspProvider | undefined; config: ResolvedConfig }): WritethroughCallback {
  const { provider, config } = options
  const versions = new Map<string, number>()
  const batches = new Map<string, EditDiagnosticsResult>()

  return async (dst, content, signal, batch): Promise<EditDiagnosticsResult | undefined> => {
    let text = content
    if (config.formatOnWrite && provider !== undefined) {
      try {
        const formatting = await provider.format({ filePath: dst, workspaceRoot: '', text }, signal)
        // formattedText is null when the server has no formatting edits.
        if (formatting !== undefined && formatting.formattedText !== null) {
          text = formatting.formattedText
        }
      } catch {
        // format unavailable/failed → keep authored content
      }
    }

    let diagnostics: EditDiagnosticsResult | undefined
    if (config.diagnosticsOnEdit && provider !== undefined) {
      try {
        const version = (versions.get(dst) ?? 0) + 1
        versions.set(dst, version)
        const collected = await provider.collectDiagnostics({
          filePath: dst,
          workspaceRoot: '',
          text,
          version,
        }, signal)
        if (collected !== undefined && collected.diagnostics.length > 0) {
          diagnostics = toDiagnosticsResult(collected.diagnostics, config.diagnosticsDeduplicate)
        }
      } catch {
        // diagnostics unavailable → no diagnostics payload
      }
    }

    // Batch semantics in essence: a non-flushing batch defers its diagnostics;
    // a flushing batch merges them and releases the ledger slot.
    if (batch) {
      const prior = batches.get(batch.id)
      const merged =
        prior !== undefined && diagnostics !== undefined
          ? {
            summary: summarizeDiagnostics([...prior.messages, ...diagnostics.messages]),
            messages: limitDiagnosticMessages([...prior.messages, ...diagnostics.messages]),
          }
          : prior ?? diagnostics
      if (!batch.flush) {
        if (merged !== undefined) batches.set(batch.id, merged)
        return merged
      }
      batches.delete(batch.id)
      return merged
    }
    return diagnostics
  }
}
