/**
 * Stale-anchor recovery must not remap an edit into a sibling construct:
 * with repeated identical shapes (two dict lists both containing
 * `"shared",`), the maximal-LCS line map can align the surviving row of one
 * list with the identical row of a newly added sibling list — a uniform
 * offset with matching neighbors — so the edit lands in the wrong block.
 * The remap is refused when the chain of enclosing constructs differs
 * between authored and remapped anchors (lexical approximation of the
 * upstream tree-sitter node chain; see src/syntax-chain.ts).
 *
 * Mirrors oh-my-pi facc0f9cdf (`recovery_refuses_a_remap_into_a_sibling_construct`
 * and `recovery_remaps_a_shift_inside_the_same_construct`).
 */
import { describe, expect, it } from 'vitest'
import {
  contextPreserved,
  enclosingContext,
  InMemoryFilesystem,
  InMemorySnapshotStore,
  MismatchError,
  Patch,
  Patcher,
  parsePatch,
  Recovery,
} from '../src/index.ts'

const PY_PATH = '/tmp/__hashline-recovery-sibling__.py'

const PREVIOUS = 'cfg = {\n    "a": [\n        "shared",\n    ],\n}\n'
const CURRENT =
  'cfg = {\n    "a": [\n        "changed",\n    ],\n    "b": [\n        "shared",\n    ],\n}\n'

describe('Recovery — sibling-construct remap gate', () => {
  it('refuses a stale-anchor remap that lands in an identically shaped sibling list', () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record(PY_PATH, PREVIOUS)

    const recovered = new Recovery(store).tryRecover({
      path: PY_PATH,
      currentText: CURRENT,
      fileHash: tag,
      edits: parsePatch('PUT >3:\n+        "new",').edits,
    })

    expect(recovered).toBeNull()
  })

  it('surfaces a MismatchError through the Patcher and leaves the file untouched', async () => {
    const fs = new InMemoryFilesystem([[PY_PATH, CURRENT]])
    const snapshots = new InMemorySnapshotStore()
    const tag = snapshots.record(PY_PATH, PREVIOUS)

    try {
      await new Patcher({ fs, snapshots }).apply(
        Patch.parse(`[${PY_PATH}#${tag}]\nPUT >3:\n+        "new",`),
      )
      throw new Error('expected MismatchError')
    } catch (error) {
      expect(error).toBeInstanceOf(MismatchError)
      const message = (error as MismatchError).displayMessage
      expect(message).toMatch(/file changed between read and edit/)
      expect(message).toMatch(/current file hashes to #[0-9A-F]{4}/)
    }
    expect(fs.get(PY_PATH)).toBe(CURRENT)
  })

  it('still remaps an anchor shifted within the same enclosing construct', () => {
    const store = new InMemorySnapshotStore()
    const previous = 'def f():\n    old()\n'
    const currentText = 'import os\n\ndef f():\n    old()\n'
    const tag = store.record(PY_PATH, previous)

    const recovered = new Recovery(store).tryRecover({
      path: PY_PATH,
      currentText,
      fileHash: tag,
      edits: parsePatch('PUT 2.=2:\n+    new()').edits,
    })

    expect(recovered).not.toBeNull()
    expect(recovered?.text).toBe('import os\n\ndef f():\n    new()\n')
  })

  it('applies directly when the tag still names live content and the construct is unchanged', async () => {
    const fs = new InMemoryFilesystem([[PY_PATH, 'def f():\n    old()\n']])
    const snapshots = new InMemorySnapshotStore()
    const tag = snapshots.record(PY_PATH, 'def f():\n    old()\n')

    const result = await new Patcher({ fs, snapshots }).apply(
      Patch.parse(`[${PY_PATH}#${tag}]\nPUT 2.=2:\n+    new()`),
    )

    expect(result.sections[0]?.op).toBe('update')
    expect(fs.get(PY_PATH)).toBe('def f():\n    new()\n')
  })
})

describe('contextPreserved — direct unit coverage', () => {
  it('rejects remaps whose anchor crosses into a sibling construct', () => {
    const authored = parsePatch('PUT >3:\n+        "new",').edits
    const remapped = parsePatch('PUT >6:\n+        "new",').edits

    expect(contextPreserved(PREVIOUS, CURRENT, PY_PATH, authored, remapped)).toBe(false)
  })

  it('accepts a shift that stays inside the same construct', () => {
    const authored = parsePatch('PUT 2.=2:\n+    new()').edits
    const remapped = parsePatch('PUT 4.=4:\n+    new()').edits

    expect(
      contextPreserved('def f():\n    old()\n', 'import os\n\ndef f():\n    old()\n', PY_PATH, authored, remapped),
    ).toBe(true)
  })

  it('allows remaps for paths with no inferable language', () => {
    const authored = parsePatch('PUT >3:\n+        "new",').edits
    const remapped = parsePatch('PUT >6:\n+        "new",').edits

    expect(contextPreserved(PREVIOUS, CURRENT, '/tmp/__hashline-noext-sibling__', authored, remapped)).toBe(true)
  })
})

describe('enclosingContext — lexical construct chains', () => {
  it('reports the dict/list bracket chain for a nested Python literal', () => {
    expect(enclosingContext(PREVIOUS.split('\n'), PY_PATH, 3)).toEqual([
      { kind: 'bracket', opener: '    "a": [' },
      { kind: 'bracket', opener: 'cfg = {' },
    ])
  })

  it('reports the indentation block for a Python function body', () => {
    expect(enclosingContext('def f():\n    old()\n'.split('\n'), PY_PATH, 2)).toEqual([
      { kind: 'block', opener: 'def f():' },
    ])
  })

  it('returns an empty chain for unknown languages', () => {
    expect(enclosingContext(PREVIOUS.split('\n'), '/tmp/__hashline-unknown__.txt', 3)).toEqual([])
  })

  it('reports brace nesting for C-like files', () => {
    const lines = ['function f() {', '  return 1;', '}', '']

    expect(enclosingContext(lines, '/tmp/__hashline-brace__.ts', 2)).toEqual([
      { kind: 'bracket', opener: 'function f() {' },
    ])
  })
})
