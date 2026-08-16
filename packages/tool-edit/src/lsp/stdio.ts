/**
 * Minimal JSON-RPC-over-stdio framing for a language-server child process,
 * self-contained inside this plugin so it works on stock DeepSeek Harness
 * deployments with no upstream LSP-seam changes.
 *
 * The harness's own LSP plumbing (`@deepseek-ai/dsh-lsp`, `dsh-lsp-stdio`)
 * is intentionally NOT consumed here: a plugin must not depend on methods
 * that only an extended harness build exposes. This tiny client speaks the
 * Language Server Protocol directly over stdin/stdout.
 * @module @hy-sde/dsh-tool-edit/lsp
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** One inbound or outbound LSP message as JSON. */
export type LspMessage = Record<string, unknown>

/** Maximum bytes buffered from the server before we refuse to grow (sanity). */
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * Split a command line into argv. Whitespace-split is intentionally naive:
 * our default (`npx --yes typescript-language-server --stdio`) has no quoted
 * arguments, and the config description tells users the same constraint.
 */
export function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/u).filter(Boolean)
}

/**
 * A live handle over one language-server process with Content-Length framing.
 * `consumer` and `closeListeners` are internal wiring, not public API: they
 * let the spawner set up the callback plumbing after the handle exists.
 */
export interface StdioLspProcess {
  readonly pid: number | undefined
  /** Send one JSON-RPC message (request or notification). */
  send(message: LspMessage): void
  /** Register the single message consumer; replaces any previous callback. */
  onMessage(consumer: (message: LspMessage) => void): void
  /** Register a close/error listener (fired once on process end). */
  onClose(listener: (code: number | null, signal: string | null) => void): void
  /** Kill the process (idempotent). */
  dispose(): void
  /** @internal single consumer of parsed inbound messages. */
  consumer: ((message: LspMessage) => void) | undefined
  /** @internal close/error listeners; cleared after the first dispatch. */
  closeListeners: Set<(code: number | null, signal: string | null) => void>
}

/**
 * Spawn a language server over stdio. Returns the process handle; a spawn
 * failure is delivered as an immediate `onClose` event with a synthetic code
 * of `null` and the error in the signal slot, so callers can treat
 * spawn-vs-crash uniformly.
 */
export function spawnLspProcess(command: string, cwd?: string): StdioLspProcess {
  const argv = splitCommand(command)
  if (argv.length === 0) {
    throw new Error(`lsp client: empty command "${command}"`)
  }
  const [cmd, ...args] = argv
  let child: ChildProcess | undefined
  try {
    child = spawn(cmd!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd === undefined ? {} : { cwd }),
      windowsHide: true,
    })
  } catch (error) {
    // Synchronous spawn failure (e.g. ENOENT for the binary) surfaces here.
    const reason = errorMessage(error)
    const handle = deadLspProcess()
    queueMicrotask(() => handle.closeListeners.forEach(listener => listener(null, `spawn:${reason}`)))
    return handle
  }

  const handle: StdioLspProcess & { child: ChildProcess } = {
    child,
    get pid() {
      return child.pid
    },
    send(message) {
      if (!child || !child.stdin || child.stdin.destroyed || child.exitCode !== null) return
      const body = JSON.stringify(message)
      const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`
      child.stdin.write(header + body)
    },
    onMessage(consumer) {
      handle.consumer = consumer
    },
    onClose(listener) {
      handle.closeListeners.add(listener)
    },
    dispose() {
      if (!child || child.killed || child.exitCode !== null) return
      child.kill()
    },
    consumer: undefined,
    closeListeners: new Set(),
  }

  let buffer = Buffer.alloc(0)
  child.stdout?.on('data', (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)])
    if (buffer.length > MAX_BUFFER) {
      child.kill() // refuse to grow unboundedly; caller falls back to edit-only
      buffer = Buffer.alloc(0)
      return
    }
    // Drain complete frames: header \r\n\r\n body.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sep = buffer.indexOf('\r\n\r\n')
      if (sep === -1) return
      const headerText = buffer.subarray(0, sep).toString('utf8')
      const lengthMatch = /Content-Length:\s*(\d+)/iu.exec(headerText)
      const bodyStart = sep + 4
      if (!lengthMatch) {
        buffer = buffer.subarray(bodyStart)
        continue
      }
      const length = Number(lengthMatch[1])
      if (buffer.length < bodyStart + length) return // wait for the rest of the body
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      buffer = buffer.subarray(bodyStart + length)
      let message: LspMessage
      try {
        message = JSON.parse(body) as LspMessage
      } catch {
        continue // malformed frame; skip it
      }
      const consumer = handle.consumer
      if (consumer) consumer(message)
    }
  })
  child.stdout?.on('error', () => { /* surfaced through close */ })
  child.stderr?.on('data', () => { /* server logs intentionally dropped */ })
  child.on('error', error => {
    for (const listener of [...handle.closeListeners]) listener(null, `error:${errorMessage(error)}`)
    handle.closeListeners.clear()
  })
  child.on('close', (code, signal) => {
    for (const listener of [...handle.closeListeners]) listener(code, signal)
    handle.closeListeners.clear()
  })
  return handle
}

/** A settled handle for the synchronous-spawn-failure path. */
function deadLspProcess(): StdioLspProcess {
  return {
    get pid() {
      return undefined
    },
    send() { /* no process */ },
    onMessage() { /* no process */ },
    onClose() { /* the spawn wrapper delivers the failure itself */ },
    dispose() { /* no process */ },
    consumer: undefined,
    closeListeners: new Set(),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
