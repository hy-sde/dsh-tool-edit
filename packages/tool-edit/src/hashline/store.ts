/**
 * Per-conversation snapshot-store hoisting for the hashline executor.
 *
 * The original kept the store on the session artifact, which persisted across
 * tool calls. This harness port rebuilds an {@link EditSession} every call, so
 * the store is hoisted onto the stable agent-session object and — crucially —
 * SHARED with the filesystem read/search tools through dsh-hashline's
 * {@link getSessionSnapshotStore}: the `read` tool records what it displayed,
 * so a tag the model copies from read output resolves to the same snapshot the
 * edit patcher verifies against, and a later call's edits fuse onto the tags
 * an earlier call's reads minted.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import { getSessionSnapshotStore, InMemorySnapshotStore, SnapshotStore } from '@hy-sde-org/dsh-hashline'

/** The per-session snapshot store for hashline anchors, created on demand. */
export function getSnapshotStore(sessionKey: object | undefined): InMemorySnapshotStore {
  return getSessionSnapshotStore(sessionKey)
}

/** SnapshotStore alias used by callers that treat the store generically. */
export type { SnapshotStore }
