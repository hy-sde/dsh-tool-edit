/**
 * Per-conversation snapshot-store hoisting for the hashline executor.
 *
 * The original kept the store on the session artifact, which persisted across
 * tool calls. This harness port rebuilds an {@link EditSession} every call, so
 * the store is hoisted onto the stable agent-session object via a WeakMap —
 * reads in one call fuse onto the tags a later call's edits verify against.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import { InMemorySnapshotStore, SnapshotStore } from '@hy-sde-org/dsh-hashline'

/** WeakMap keyed by the stable agent Session object (never prevents GC). */
const storeBySession = new WeakMap<object, InMemorySnapshotStore>()

/** The per-session snapshot store for hashline anchors, created on demand. */
export function getSnapshotStore(sessionKey: object | undefined): InMemorySnapshotStore {
  if (sessionKey !== undefined) {
    let store = storeBySession.get(sessionKey)
    if (store) return store
    store = new InMemorySnapshotStore()
    storeBySession.set(sessionKey, store)
    return store
  }
  // No stable session (agentless): scratch store, valid for this call only.
  return new InMemorySnapshotStore()
}

/** SnapshotStore alias used by callers that treat the store generically. */
export type { SnapshotStore }
