import { describe, expect, it } from 'vitest'
import { computeFileHash, getSessionSnapshotStore, SNAPSHOT_MAX_BYTES } from '../src/index.ts'

/**
 * The per-session store accessor is the cross-package contract behind omp
 * first-try editing (fork commit bfce5d6505): tool-fs's `read`, any grep tool,
 * and tool-edit's patcher all resolve the SAME store for a given agent
 * Session, so a tag the model copies from read output validates against the
 * exact content (and lines) it saw.
 */

describe('getSessionSnapshotStore', () => {
  it('returns one store per session key, shared across callers', () => {
    const a = { marker: 'session-a' }
    const b = { marker: 'session-b' }
    expect(getSessionSnapshotStore(a)).toBe(getSessionSnapshotStore(a))
    expect(getSessionSnapshotStore(b)).toBe(getSessionSnapshotStore(b))
    expect(getSessionSnapshotStore(a)).not.toBe(getSessionSnapshotStore(b))
  })

  it('gives an agentless caller a fresh scratch store every call', () => {
    // Undefined key = direct/agentless execution: no stable owner, so the
    // scratch store must not accumulate state across calls. Tags stay
    // content-derived, but recovery history does not leak between calls.
    expect(getSessionSnapshotStore(undefined)).not.toBe(getSessionSnapshotStore(undefined))
  })

  it('lets an external producer mint a tag the patcher validates', () => {
    const session = { marker: 'session-read-producer' }
    const store = getSessionSnapshotStore(session)
    const text = 'line one\nline two\nline three\n'
    const tag = store.record('/repo/a.ts', text, [1, 2, 3])
    expect(tag).toBe(computeFileHash(text))

    // The whole parsed snapshot (content + seen lines) is queryable through
    // the same accessor — a later call's edit fuses onto this provenance.
    const snapshot = store.byContent('/repo/a.ts', text)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.text).toBe(text)
    expect([...snapshot!.seenLines!]).toEqual([1, 2, 3])
  })

  it('exports the snapshot size budget', () => {
    expect(SNAPSHOT_MAX_BYTES).toBe(4 * 1024 * 1024)
  })
})
