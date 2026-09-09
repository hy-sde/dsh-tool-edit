/**
 * Session-keyed hashline snapshot-store accessor shared across tool packages.
 *
 * A snapshot tag is a content-derived 16-bit hash of the whole normalized file
 * (see {@link computeFileHash}), so any read of byte-identical content mints
 * the same tag and `read`-side producers and the `edit` patcher can share tags
 * even before a store round-trip. Sharing ONE store per agent session is what
 * makes recovery and seen-line provenance work across tool calls: the `read`
 * tool records what it displayed so a later `edit` verifies its anchors
 * against the exact content (and lines) the model saw.
 *
 * Producers (typically the `read`/`grep` tools and the edit patcher's own
 * reads) call {@link getSessionSnapshotStore} with the stable agent Session
 * object and record/query through the returned store. The accessor is a
 * module-level `WeakMap` keyed by that object — it never prevents GC, and an
 * agentless call (no session) gets a scratch store valid for that call only,
 * exactly like the original coding-agent hoisting in `tool-edit`.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import { InMemorySnapshotStore, type InMemorySnapshotStoreOptions } from './snapshots.ts'

/**
 * Upper bound on a single file's bytes eligible for session snapshotting.
 * Mirrors oh-my-pi's `SNAPSHOT_MAX_BYTES`: past this size a file is not
 * snapshotted (reads still render line-numbered output, just without a
 * hashline tag header), so one giant file cannot evict a session's whole
 * snapshot budget.
 */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024

const storesBySession = new WeakMap<object, InMemorySnapshotStore>()

/**
 * The session's hashline snapshot store, created on demand. `undefined`
 * (agentless direct execution) yields a scratch store that does not persist
 * across calls — tags are still content-derived so the rendered header stays
 * correct, but in-session recovery history does not accumulate.
 */
export function getSessionSnapshotStore(
  sessionKey: object | undefined,
  options: InMemorySnapshotStoreOptions = {},
): InMemorySnapshotStore {
  if (sessionKey === undefined) return new InMemorySnapshotStore(options)
  let store = storesBySession.get(sessionKey)
  if (store === undefined) {
    store = new InMemorySnapshotStore(options)
    storesBySession.set(sessionKey, store)
  }
  return store
}
