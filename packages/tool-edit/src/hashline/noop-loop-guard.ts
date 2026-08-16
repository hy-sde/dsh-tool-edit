/**
 * Per-edit-session guard against subagents looping on byte-identical no-op
 * edits. Tracked on the session object (mirroring the original's
 * session-attached slot) so the state survives across tool calls within one
 * session.
 *
 * Once the same payload has no-op'd {@link NOOP_HARD_LIMIT} times in a row the
 * caller escalates from a soft text result to a thrown error so the agent loop
 * sees a tool *failure* — far more effective at breaking the cycle than the
 * soft hint alone (issue #2081 in oh-my-pi captured 182 byte-identical no-op
 * results in 205 calls before the user aborted).
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */

interface NoopLoopEntry {
  /** Hash of the most recent input that no-op'd on this canonical path. */
  hash: string
  /** Consecutive no-op count for the same `hash` on this path. */
  count: number
}

/** Cross-session-safe state slot held on the session adapter. */
export interface NoopLoopGuard {
  entries: Map<string, NoopLoopEntry>
}

/** Symbol slot name held on the (opaque) session — no cross-package type dep. */
export const NOOP_GUARD_SLOT: unique symbol = Symbol('dsh.tool-edit.noopLoopGuard')

/**
 * After this many consecutive byte-identical no-op edits on the same path,
 * {@link recordNoopEdit} returns `escalate: true`. Picked deliberately small
 * so the soft hint still fires once or twice before we escalate.
 */
export const NOOP_HARD_LIMIT = 3

type NoopLoopGuardOwner = { [NOOP_GUARD_SLOT]?: NoopLoopGuard }

/** Result of recording one no-op against the guard. */
export interface NoopRecordResult {
  /** Consecutive identical no-op count, including the current one. */
  count: number
  /** True once `count >= NOOP_HARD_LIMIT` and the caller MUST escalate. */
  escalate: boolean
}

/**
 * Record a no-op edit for `canonicalPath` keyed by `inputHash` (a stable hash
 * of the raw patch input bytes). Returns the running consecutive-no-op count
 * and whether the caller should escalate from a soft text result to a thrown
 * error. A different payload earns a fresh soft hint.
 */
export function recordNoopEdit(
  owner: NoopLoopGuardOwner,
  canonicalPath: string,
  inputHash: string,
): NoopRecordResult {
  const guard = (owner[NOOP_GUARD_SLOT] ??= { entries: new Map() })
  const prev = guard.entries.get(canonicalPath)
  const count = prev && prev.hash === inputHash ? prev.count + 1 : 1
  guard.entries.set(canonicalPath, { hash: inputHash, count })
  return { count, escalate: count >= NOOP_HARD_LIMIT }
}

/**
 * Clear the no-op counter for `canonicalPath`. Call after a non-noop commit
 * for the same path so a future no-op starts fresh from the soft hint.
 */
export function resetNoopEdit(owner: NoopLoopGuardOwner, canonicalPath: string): void {
  const guard = owner[NOOP_GUARD_SLOT]
  if (!guard) return
  guard.entries.delete(canonicalPath)
}

/**
 * Stable hash of the raw patch input. The original used Bun's `Bun.hash`
 * (xxHash64); this small mixed hash is deterministic across V8/Node versions
 * and adequate for "is this the same payload?" (non-cryptographic by design).
 */
export function hashPatchInput(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}
