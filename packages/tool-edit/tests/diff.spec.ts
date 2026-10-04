import { describe, expect, it } from 'vitest'
import { diffLines } from '../src/diff.ts'

describe('diffLines (degenerate Hirschberg splits)', () => {
  it('handles a 1-line old_string replaced by a large block that drops the line', () => {
    // Regression: n === 1 made mid = 0, the forward LCS table all zeros, and
    // bestJ stuck at 0 — the right half recursed on identical arguments until
    // the stack blew ("Maximum call stack size exceeded").
    const newBlock = Array.from({ length: 200 }, (_, i) => `- item ${i}`).join('\n')
    const parts = diffLines('<!-- MARKER -->\n', `${newBlock}\n`)
    expect(parts.some(p => p.removed)).toBe(true)
    expect(parts.some(p => p.added)).toBe(true)
    expect(parts.map(p => p.value).join('')).toContain('- item 199')
  })

  it('handles a small replacement into a large block', () => {
    const oldBlock = Array.from({ length: 95 }, (_, i) => `original ${i}`).join('\n')
    const newBlock = Array.from({ length: 95 }, (_, i) => `replaced ${i}`).join('\n')
    const parts = diffLines(oldBlock, newBlock)
    expect(parts.filter(p => p.removed).map(p => p.value).join('')).toContain('original 0')
    expect(parts.filter(p => p.added).map(p => p.value).join('')).toContain('replaced 0')
  })

  it('keeps identical content as context', () => {
    const parts = diffLines('alpha\nbeta\n', 'alpha\nbeta\n')
    expect(parts).toHaveLength(1)
    expect(parts[0]?.added).toBeUndefined()
    expect(parts[0]?.removed).toBeUndefined()
  })
})
